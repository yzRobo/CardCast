// src/tcg-api.js - Fixed CardCast TCG API with Proper Incremental Updates
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

class TCGApi {
    constructor(database) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        this.cacheDir = path.join(__dirname, '..', 'cache');
        this.imagesDir = path.join(__dirname, '..', 'cache', 'images');
        
        // Ensure directories exist
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        if (!fs.existsSync(this.imagesDir)) {
            fs.mkdirSync(this.imagesDir, { recursive: true });
        }
        
        // Create game-specific image directories
        const games = ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'fab', 'starwars'];
        games.forEach(game => {
            const gameDir = path.join(this.imagesDir, game);
            if (!fs.existsSync(gameDir)) {
                fs.mkdirSync(gameDir, { recursive: true });
            }
        });
        
        this.gameConfigs = {
            pokemon: {
                name: 'Pokemon',
                apiUrl: 'https://api.pokemontcg.io/v2/cards',
                parseCard: this.parsePokemonCard.bind(this)
            },
            magic: {
                name: 'Magic: The Gathering',
                apiUrl: 'https://api.scryfall.com/cards/search',
                parseCard: this.parseMagicCard.bind(this)
            },
            yugioh: {
                name: 'Yu-Gi-Oh!',
                apiUrl: 'https://db.ygoprodeck.com/api/v7/cardinfo.php',
                parseCard: this.parseYugiohCard.bind(this)
            },
            lorcana: {
                name: 'Disney Lorcana',
                apiUrl: null,
                parseCard: this.parseLorcanaCard.bind(this)
            },
            onepiece: {
                name: 'One Piece Card Game',
                apiUrl: null,
                parseCard: this.parseOnePieceCard.bind(this)
            }
        };
    }
    
    // Helper method to get downloaded sets from database
    getDownloadedSets(game) {
        try {
            // Check if the database has this method
            if (this.db.getDownloadedSets) {
                return this.db.getDownloadedSets(game);
            }
            
            // Fallback: manually query the database
            const stmt = this.db.db.prepare(`
                SELECT DISTINCT set_code 
                FROM cards 
                WHERE game = ?
            `);
            const results = stmt.all(game);
            return new Set(results.map(r => r.set_code));
        } catch (error) {
            console.error(`Error getting downloaded sets for ${game}:`, error);
            return new Set();
        }
    }
    
    async downloadGameData(game, progressCallback, incremental = false, setCount = 'all') {
        const config = this.gameConfigs[game];
        if (!config) {
            throw new Error(`Unsupported game: ${game}`);
        }
        
        console.log(`Starting ${incremental ? 'incremental update' : 'full download'} for ${config.name} (${setCount} sets)...`);
        progressCallback({ status: 'starting', percent: 0, message: incremental ? 'Preparing update...' : 'Preparing download...' });
        
        try {
            // Only clear existing data if NOT incremental
            if (!incremental) {
                console.log(`Clearing existing data for ${game}...`);
                try {
                    this.db.clearGameData(game);
                    this.clearGameImages(game);
                } catch (clearError) {
                    console.error(`Error clearing data for ${game}:`, clearError);
                    // Continue anyway - we'll overwrite the data
                }
            } else {
                console.log(`Incremental update - keeping existing data for ${game}`);
            }
            
            progressCallback({ status: 'fetching', percent: 10, message: 'Fetching card data...' });
            
            let cards = [];
            let existingCardCount = 0;
            
            // Get existing card count for incremental updates
            if (incremental) {
                const stats = this.db.getGameStats().find(g => g.id === game);
                existingCardCount = stats?.card_count || 0;
                console.log(`Existing cards in database: ${existingCardCount}`);
            }
            
            // Fetch cards based on game
            switch(game) {
                case 'pokemon':
                    cards = await this.fetchPokemonCards(progressCallback, incremental, setCount);
                    break;
                case 'magic':
                    cards = await this.fetchMagicCards(progressCallback, incremental, setCount);
                    break;
                case 'yugioh':
                    cards = await this.fetchYugiohCards(progressCallback, incremental, setCount);
                    break;
                default:
                    // For unsupported games, generate sample data for testing
                    console.log(`Using sample data for ${game}`);
                    cards = this.generateSampleCards(game);
            }
            
            console.log(`Fetched ${cards.length} ${incremental ? 'new' : ''} cards for ${game}`);
            
            if (cards.length === 0 && !incremental) {
                throw new Error('No cards were fetched');
            }
            
            if (cards.length > 0) {
                // Download images for cards
                progressCallback({ status: 'downloading', percent: 70, message: `Downloading images for ${cards.length} cards...` });
                await this.downloadCardImages(cards, game, progressCallback);
                
                // Save to database
                progressCallback({ status: 'saving', percent: 90, message: 'Saving to database...' });
                
                const batchSize = 100;
                for (let i = 0; i < cards.length; i += batchSize) {
                    const batch = cards.slice(i, i + batchSize);
                    try {
                        this.db.bulkInsertCards(batch);
                    } catch (insertError) {
                        console.error(`Error inserting batch at ${i}:`, insertError);
                        // Continue with other batches
                    }
                    
                    const savePercent = 90 + (i / cards.length) * 10;
                    progressCallback({ 
                        status: 'saving', 
                        percent: Math.floor(savePercent), 
                        message: `Saving cards... (${Math.min(i + batchSize, cards.length)}/${cards.length})`
                    });
                }
            }
            
            // Update game info with new total
            const finalCardCount = incremental ? existingCardCount + cards.length : cards.length;
            this.db.updateGameInfo(game, finalCardCount);
            
            progressCallback({ status: 'complete', percent: 100, message: incremental ? 'Update complete!' : 'Download complete!' });
            console.log(`${incremental ? 'Updated' : 'Downloaded'} ${cards.length} cards for ${config.name}. Total cards: ${finalCardCount}`);
            
            return cards.length;
        } catch (error) {
            console.error(`Error ${incremental ? 'updating' : 'downloading'} ${game} data:`, error);
            // Don't reset count on error if incremental
            if (!incremental) {
                this.db.updateGameInfo(game, 0);
            }
            throw error;
        }
    }
    
    async fetchPokemonCards(progressCallback, incremental = false, setCount = 'all') {
        console.log(`Starting Pokemon card fetch (${incremental ? 'incremental' : 'full'}, ${setCount} sets)...`);
        const cards = [];
        const cardMap = new Map();
        
        try {
            progressCallback({ 
                status: 'fetching', 
                percent: 5, 
                message: 'Fetching available Pokemon sets...'
            });
            
            let allSets = [];
            let energySets = [];
            let setMappings = new Map();
            
            const setsResponse = await axios.get('https://api.pokemontcg.io/v2/sets', {
                params: {
                    orderBy: '-releaseDate',
                    pageSize: 250
                },
                timeout: 30000,
                headers: {
                    'User-Agent': 'CardCast/1.0.0',
                    'Accept': 'application/json'
                }
            });
            
            if (setsResponse.data && setsResponse.data.data) {
                // Separate regular sets from energy sets
                setsResponse.data.data.forEach(set => {
                    if (set.ptcgoCode) {
                        setMappings.set(set.id, set.ptcgoCode);
                    }
                    
                    // Check if this is an energy set
                    if (set.id === 'sve' || set.id === 'sme' || 
                        set.name?.toLowerCase().includes('energies') ||
                        set.name?.toLowerCase().includes('energy')) {
                        energySets.push(set);
                        console.log(`Found energy set: ${set.name} (${set.id})`);
                    } else if (set.series !== 'Other' && !set.name?.includes('Promo')) {
                        allSets.push(set);
                    }
                });
                
                console.log(`Found ${allSets.length} regular sets and ${energySets.length} energy sets`);
            } else {
                throw new Error('No sets data received from API');
            }
            
            // Determine which sets to fetch
            let setsToFetch = [];
            
            if (incremental) {
                const downloadedSets = this.getDownloadedSets('pokemon');
                console.log(`Already have ${downloadedSets.size} sets in database`);
                
                const availableSets = allSets.filter(set => !downloadedSets.has(set.id));
                console.log(`Found ${availableSets.length} sets not yet downloaded`);
                
                if (availableSets.length === 0) {
                    console.log('No new sets available for incremental update');
                    return [];
                }
                
                if (setCount === 'all') {
                    setsToFetch = availableSets;
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = availableSets.slice(0, count);
                }
            } else {
                if (setCount === 'all') {
                    setsToFetch = allSets;
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = allSets.slice(0, count);
                }
            }
            
            console.log(`Will fetch ${setsToFetch.length} sets: ${setsToFetch.map(s => s.id).join(', ')}`);
            
            // Fetch cards from selected sets
            for (let i = 0; i < setsToFetch.length; i++) {
                const set = setsToFetch[i];
                progressCallback({ 
                    status: 'downloading', 
                    percent: 10 + (i / setsToFetch.length) * 60, 
                    message: `Fetching ${set.name} (${i + 1}/${setsToFetch.length})...`
                });
                
                let retries = 3;
                let success = false;
                
                while (retries > 0 && !success) {
                    try {
                        const response = await axios.get('https://api.pokemontcg.io/v2/cards', {
                            params: {
                                q: `set.id:${set.id}`,
                                pageSize: 250
                            },
                            timeout: 60000,
                            headers: {
                                'User-Agent': 'CardCast/1.0.0',
                                'Accept': 'application/json'
                            }
                        });
                        
                        if (response.data && response.data.data) {
                            console.log(`${set.name}: Got ${response.data.data.length} cards`);
                            
                            response.data.data.forEach(card => {
                                if (!cardMap.has(card.id)) {
                                    const setAbbreviation = card.set?.ptcgoCode || 
                                                          setMappings.get(card.set?.id) || 
                                                          set.ptcgoCode || 
                                                          null;
                                    
                                    const cardData = {
                                        id: `pokemon_${card.id}`,
                                        game: 'pokemon',
                                        product_id: card.id,
                                        name: card.name,
                                        set_name: card.set?.name || set.name,
                                        set_code: card.set?.id || set.id,
                                        set_abbreviation: setAbbreviation,
                                        card_number: card.number || '',
                                        image_url: card.images?.large || card.images?.small || '',
                                        rarity: card.rarity || 'Common',
                                        card_type: card.supertype || 'Pokemon',
                                        card_text: this.buildPokemonText(card),
                                        hp: card.hp || null,
                                        stage: card.subtypes?.join(', ') || null,
                                        evolves_from: card.evolvesFrom || null,
                                        weakness: card.weaknesses?.[0] ? `${card.weaknesses[0].type} ${card.weaknesses[0].value}` : null,
                                        resistance: card.resistances?.[0] ? `${card.resistances[0].type} ${card.resistances[0].value}` : null,
                                        retreat_cost: card.retreatCost?.join('') || null,
                                        ability_name: card.abilities?.[0]?.name || null,
                                        ability_text: card.abilities?.[0]?.text || null,
                                        attack1_name: card.attacks?.[0]?.name || null,
                                        attack1_cost: card.attacks?.[0]?.cost?.join('') || null,
                                        attack1_damage: card.attacks?.[0]?.damage || null,
                                        attack1_text: card.attacks?.[0]?.text || null,
                                        attack2_name: card.attacks?.[1]?.name || null,
                                        attack2_cost: card.attacks?.[1]?.cost?.join('') || null,
                                        attack2_damage: card.attacks?.[1]?.damage || null,
                                        attack2_text: card.attacks?.[1]?.text || null,
                                        attributes: {
                                            hp: card.hp || null,
                                            types: card.types || [],
                                            retreatCost: card.retreatCost?.length || 0,
                                            attacks: card.attacks || [],
                                            abilities: card.abilities || []
                                        }
                                    };
                                    cardMap.set(card.id, cardData);
                                }
                            });
                            success = true;
                        }
                    } catch (setError) {
                        retries--;
                        console.error(`Error fetching Pokemon set ${set.id}, retries left ${retries}:`, setError.message);
                        if (retries > 0) {
                            await this.delay(3000);
                        }
                    }
                }
                
                if (!success) {
                    console.log(`Skipping set ${set.id} after all retries failed`);
                }
                
                await this.delay(200);
            }
            
            // FETCH ENERGY CARDS FROM API
            progressCallback({ 
                status: 'fetching', 
                percent: 70, 
                message: 'Fetching energy cards...'
            });
            
            // Find the appropriate energy set to fetch
            if (energySets.length > 0) {
                // Get the series of what we're downloading
                const targetSeries = setsToFetch[0]?.series || 'Scarlet & Violet';
                
                // Find matching energy set or use most recent
                let energySetToFetch = energySets.find(set => set.series === targetSeries) || energySets[0];
                
                console.log(`Fetching energy set: ${energySetToFetch.name} (${energySetToFetch.id})`);
                
                try {
                    const energyResponse = await axios.get('https://api.pokemontcg.io/v2/cards', {
                        params: {
                            q: `set.id:${energySetToFetch.id}`,
                            pageSize: 250
                        },
                        timeout: 60000,
                        headers: {
                            'User-Agent': 'CardCast/1.0.0',
                            'Accept': 'application/json'
                        }
                    });
                    
                    if (energyResponse.data && energyResponse.data.data) {
                        console.log(`${energySetToFetch.name}: Got ${energyResponse.data.data.length} energy cards`);
                        
                        energyResponse.data.data.forEach(card => {
                            if (!cardMap.has(card.id)) {
                                const setAbbreviation = card.set?.ptcgoCode || 
                                                      setMappings.get(card.set?.id) || 
                                                      energySetToFetch.ptcgoCode || 
                                                      energySetToFetch.id.toUpperCase();
                                
                                const cardData = {
                                    id: `pokemon_${card.id}`,
                                    game: 'pokemon',
                                    product_id: card.id,
                                    name: card.name,
                                    set_name: card.set?.name || energySetToFetch.name,
                                    set_code: card.set?.id || energySetToFetch.id,
                                    set_abbreviation: setAbbreviation,
                                    card_number: card.number || '',
                                    image_url: card.images?.large || card.images?.small || '',
                                    rarity: card.rarity || 'Common',
                                    card_type: card.supertype || 'Energy',
                                    card_text: this.buildPokemonText(card),
                                    hp: card.hp || null,
                                    stage: card.subtypes?.join(', ') || null,
                                    evolves_from: card.evolvesFrom || null,
                                    weakness: card.weaknesses?.[0] ? `${card.weaknesses[0].type} ${card.weaknesses[0].value}` : null,
                                    resistance: card.resistances?.[0] ? `${card.resistances[0].type} ${card.resistances[0].value}` : null,
                                    retreat_cost: card.retreatCost?.join('') || null,
                                    ability_name: card.abilities?.[0]?.name || null,
                                    ability_text: card.abilities?.[0]?.text || null,
                                    attack1_name: card.attacks?.[0]?.name || null,
                                    attack1_cost: card.attacks?.[0]?.cost?.join('') || null,
                                    attack1_damage: card.attacks?.[0]?.damage || null,
                                    attack1_text: card.attacks?.[0]?.text || null,
                                    attack2_name: card.attacks?.[1]?.name || null,
                                    attack2_cost: card.attacks?.[1]?.cost?.join('') || null,
                                    attack2_damage: card.attacks?.[1]?.damage || null,
                                    attack2_text: card.attacks?.[1]?.text || null,
                                    attributes: {
                                        hp: card.hp || null,
                                        types: card.types || [],
                                        retreatCost: card.retreatCost?.length || 0,
                                        attacks: card.attacks || [],
                                        abilities: card.abilities || []
                                    }
                                };
                                cardMap.set(card.id, cardData);
                            }
                        });
                    }
                } catch (energyError) {
                    console.error(`Error fetching energy set ${energySetToFetch.id}:`, energyError.message);
                }
            } else {
                console.log('No energy sets found in API response');
            }
            
            // Convert map to array
            cards.push(...cardMap.values());
            
            const energyCardCount = cards.filter(c => c.card_type === 'Energy').length;
            console.log(`Total Pokemon cards fetched: ${cards.length} (including ${energyCardCount} energy cards)`);
            
        } catch (error) {
            console.error('Error fetching Pokemon cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }
        
        return cards;
    }
        
    async fetchMagicCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];
        const cardMap = new Map();
        
        try {
            // First, fetch recent sets
            progressCallback({ 
                status: 'fetching', 
                percent: 5, 
                message: 'Fetching available Magic sets...'
            });
            
            let allSets = [];
            try {
                const setsResponse = await axios.get('https://api.scryfall.com/sets', {
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'CardCast/1.0.0'
                    }
                });
                
                if (setsResponse.data && setsResponse.data.data) {
                    // Filter for main sets only, sorted by release date
                    allSets = setsResponse.data.data
                        .filter(set => set.set_type === 'core' || set.set_type === 'expansion')
                        .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));
                    console.log(`Found ${allSets.length} Magic sets`);
                }
            } catch (setsError) {
                console.error('Error fetching Magic sets:', setsError.message);
                // Fall back to recent set codes
                allSets = [
                    { code: 'dsk', name: 'Duskmourn' },
                    { code: 'blb', name: 'Bloomburrow' },
                    { code: 'otj', name: 'Outlaws of Thunder Junction' },
                    { code: 'mkm', name: 'Murders at Karlov Manor' },
                    { code: 'lci', name: 'The Lost Caverns of Ixalan' }
                ];
            }
            
            // Determine which sets to fetch
            let setsToFetch = [];
            
            if (incremental) {
                // For incremental updates, get sets we don't already have
                const downloadedSets = this.getDownloadedSets('magic');
                console.log(`Already have ${downloadedSets.size} sets in database`);
                
                // Filter out sets we already have
                const availableSets = allSets.filter(set => !downloadedSets.has(set.code));
                console.log(`Found ${availableSets.length} sets not yet downloaded`);
                
                if (availableSets.length === 0) {
                    console.log('No new sets available for incremental update');
                    return [];
                }
                
                if (setCount === 'all') {
                    // For Magic, limit to last 20 sets for "all" to be reasonable
                    setsToFetch = availableSets.slice(0, 20);
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = availableSets.slice(0, count);
                }
            } else {
                // For full download
                if (setCount === 'all') {
                    // For Magic, limit to last 20 sets for "all" to be reasonable
                    setsToFetch = allSets.slice(0, 20);
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = allSets.slice(0, count);
                }
            }
            
            console.log(`Will fetch ${setsToFetch.length} Magic sets`);
            
            // Fetch cards from selected sets
            for (let i = 0; i < setsToFetch.length; i++) {
                const set = setsToFetch[i];
                progressCallback({ 
                    status: 'downloading', 
                    percent: 10 + (i / setsToFetch.length) * 60, 
                    message: `Fetching ${set.name} (${i + 1}/${setsToFetch.length})...`
                });
                
                try {
                    let hasMore = true;
                    let page = 1;
                    let searchUrl = 'https://api.scryfall.com/cards/search';
                    
                    while (hasMore && page <= 5) {
                        const response = await axios.get(searchUrl, {
                            params: {
                                q: `set:${set.code}`,
                                page: page,
                                format: 'json',
                                unique: 'cards'
                            },
                            timeout: 30000,
                            headers: {
                                'User-Agent': 'CardCast/1.0.0'
                            }
                        });
                        
                        if (response.data && response.data.data) {
                            console.log(`${set.name} page ${page}: Got ${response.data.data.length} cards`);
                            
                            response.data.data.forEach(card => {
                                if (!cardMap.has(card.id)) {
                                    const cardData = {
                                        id: `magic_${card.id}`,
                                        game: 'magic',
                                        name: card.name,
                                        set_name: card.set_name || set.name,
                                        set_code: card.set || set.code,
                                        set_abbreviation: card.set?.toUpperCase() || set.code?.toUpperCase(),
                                        card_number: card.collector_number || '',
                                        image_url: card.image_uris?.normal || card.image_uris?.small || card.card_faces?.[0]?.image_uris?.normal || '',
                                        rarity: card.rarity || 'common',
                                        card_type: card.type_line || '',
                                        card_text: card.oracle_text || card.card_faces?.[0]?.oracle_text || '',
                                        // Store Magic-specific attributes
                                        mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || '',
                                        cmc: card.cmc || 0,
                                        power: card.power || null,
                                        toughness: card.toughness || null,
                                        loyalty: card.loyalty || null,
                                        colors: card.colors?.join(',') || '',
                                        color_identity: card.color_identity?.join(',') || '',
                                        type_line: card.type_line || '',
                                        oracle_text: card.oracle_text || '',
                                        flavor_text: card.flavor_text || '',
                                        attributes: {
                                            manaCost: card.mana_cost || card.card_faces?.[0]?.mana_cost || '',
                                            cmc: card.cmc || 0,
                                            power: card.power || null,
                                            toughness: card.toughness || null,
                                            colors: card.colors || card.color_identity || []
                                        }
                                    };
                                    cardMap.set(card.id, cardData);
                                }
                            });
                            
                            hasMore = response.data.has_more || false;
                            if (response.data.next_page) {
                                searchUrl = response.data.next_page;
                                page++;
                            } else {
                                hasMore = false;
                            }
                        } else {
                            hasMore = false;
                        }
                        
                        await this.delay(100);
                    }
                } catch (setError) {
                    console.error(`Error fetching Magic set ${set.code}:`, setError.message);
                }
                
                await this.delay(200);
            }
            
            // Convert map to array
            cards.push(...cardMap.values());
            console.log(`Total unique Magic cards fetched: ${cards.length}`);
            
        } catch (error) {
            console.error('Error fetching Magic cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }
        
        return cards;
    }
    
    async fetchYugiohCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];
        
        try {
            progressCallback({ 
                status: 'downloading', 
                percent: 40, 
                message: 'Fetching Yu-Gi-Oh! cards...'
            });
            
            // For YuGiOh incremental updates, we need a different approach
            // since the API doesn't have traditional "sets" like Pokemon/Magic
            if (incremental) {
                // Get the latest cards
                const cardLimit = setCount === 'all' ? 100 : parseInt(setCount) * 20 || 60;
                
                const response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                    params: {
                        num: cardLimit,
                        offset: 0,
                        sort: 'new'
                    },
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'CardCast/1.0.0'
                    }
                });
                
                if (response.data && response.data.data) {
                    console.log(`YuGiOh: Got ${response.data.data.length} new cards`);
                    response.data.data.forEach(card => {
                        cards.push(this.parseYugiohCardData(card));
                    });
                }
            } else {
                // For full download, get staple cards
                const cardLimit = setCount === 'all' ? 500 : parseInt(setCount) * 50 || 100;
                
                const response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                    params: {
                        staple: 'yes',
                        num: Math.min(cardLimit, 500),
                        offset: 0
                    },
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'CardCast/1.0.0'
                    }
                });
                
                if (response.data && response.data.data) {
                    console.log(`YuGiOh: Got ${response.data.data.length} cards`);
                    response.data.data.forEach(card => {
                        cards.push(this.parseYugiohCardData(card));
                    });
                }
            }
        } catch (error) {
            console.error('Error fetching Yu-Gi-Oh! cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }
        
        return cards;
    }
    
    parseYugiohCardData(card) {
        return {
            id: `yugioh_${card.id}`,
            game: 'yugioh',
            name: card.name,
            set_name: card.card_sets?.[0]?.set_name || '',
            set_code: card.card_sets?.[0]?.set_code || '',
            set_abbreviation: card.card_sets?.[0]?.set_code || '',
            card_number: card.card_sets?.[0]?.set_code || '',
            image_url: card.card_images?.[0]?.image_url || '',
            rarity: card.card_sets?.[0]?.set_rarity || 'Common',
            card_type: card.type || '',
            card_text: card.desc || '',
            // Store YuGiOh-specific attributes
            attack: card.atk || null,
            defense: card.def || null,
            level: card.level || null,
            rank: card.rank || null,
            link_value: card.linkval || null,
            pendulum_scale: card.scale || null,
            attribute: card.attribute || '',
            monster_type: card.race || '',
            attributes: {
                attack: card.atk || null,
                defense: card.def || null,
                level: card.level || null,
                attribute: card.attribute || '',
                race: card.race || ''
            }
        };
    }
    
    // Rest of the methods remain the same...
    async downloadCardImages(cards, game, progressCallback) {
        const totalCards = cards.length;
        const downloadBatch = 10; // Download 10 images at a time
        let downloaded = 0;
        
        for (let i = 0; i < cards.length; i += downloadBatch) {
            const batch = cards.slice(i, i + downloadBatch);
            const promises = batch.map(async (card) => {
                if (card.image_url) {
                    try {
                        const localPath = await this.downloadImage(card.image_url, card.id, game);
                        card.local_image = localPath;
                        // Update the image_url to use the local path
                        if (localPath && localPath !== card.image_url) {
                            card.image_url = `/cache/images/${game}/${path.basename(localPath)}`;
                        }
                    } catch (err) {
                        console.error(`Failed to download image for ${card.name}:`, err.message);
                    }
                }
            });
            
            await Promise.all(promises);
            downloaded += batch.length;
            
            const percent = 70 + (downloaded / totalCards) * 20;
            progressCallback({
                status: 'downloading',
                percent: Math.floor(percent),
                message: `Downloading images... (${downloaded}/${totalCards})`
            });
        }
    }
    
    async downloadImage(imageUrl, cardId, game) {
        if (!imageUrl || imageUrl.includes('placeholder')) {
            return imageUrl;
        }
        
        try {
            // Sanitize the card ID for filename
            const safeId = cardId.replace(/[^a-z0-9_-]/gi, '_');
            const extension = '.jpg'; // Always use jpg for consistency
            const imagePath = path.join(this.imagesDir, game, `${safeId}${extension}`);
            
            // Check if already cached
            if (fs.existsSync(imagePath)) {
                return imagePath;
            }
            
            // Download image with retry logic
            let retries = 3;
            let lastError;
            
            while (retries > 0) {
                try {
                    const response = await axios.get(imageUrl, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        headers: {
                            'User-Agent': 'CardCast/1.0.0'
                        }
                    });
                    
                    fs.writeFileSync(imagePath, response.data);
                    return imagePath;
                } catch (error) {
                    lastError = error;
                    retries--;
                    if (retries > 0) {
                        await this.delay(1000); // Wait 1 second before retry
                    }
                }
            }
            
            throw lastError;
        } catch (error) {
            console.error(`Error downloading image for ${cardId}:`, error.message);
            return imageUrl; // Return original URL if download fails
        }
    }
    
    clearGameImages(game) {
        const gameDir = path.join(this.imagesDir, game);
        if (fs.existsSync(gameDir)) {
            try {
                const files = fs.readdirSync(gameDir);
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(gameDir, file));
                    } catch (err) {
                        console.error(`Error deleting file ${file}:`, err.message);
                    }
                });
                console.log(`Cleared ${files.length} cached images for ${game}`);
            } catch (err) {
                console.error(`Error clearing images for ${game}:`, err.message);
            }
        }
    }
    
    buildPokemonText(card) {
        let text = '';
        
        if (card.abilities) {
            card.abilities.forEach(ability => {
                text += `${ability.type}: ${ability.name}\n${ability.text}\n\n`;
            });
        }
        
        if (card.attacks) {
            card.attacks.forEach(attack => {
                text += `${attack.name} - ${attack.damage || ''}\n${attack.text || ''}\n\n`;
            });
        }
        
        if (card.rules) {
            text += card.rules.join('\n');
        }
        
        return text.trim();
    }
    
    // Sample data generation methods
    generateSampleCards(game) {
        const cards = [];
        const sets = this.getSampleSets(game);
        
        sets.forEach((set) => {
            for (let i = 1; i <= 20; i++) {
                const card = {
                    id: `${game}_${set.code}_${i}`,
                    game: game,
                    name: `${set.name} Card ${i}`,
                    set_name: set.name,
                    set_code: set.code,
                    set_abbreviation: set.code.toUpperCase(),
                    card_number: `${i}/${set.totalCards}`,
                    image_url: this.getSampleImageUrl(game, set.code, i),
                    rarity: this.getRandomRarity(),
                    card_type: this.getCardType(game),
                    card_text: `Sample card text for ${game} card ${i}`,
                    attributes: this.getGameAttributes(game)
                };
                cards.push(card);
            }
        });
        
        return cards;
    }
    
    getSampleSets(game) {
        const sets = {
            pokemon: [
                { name: 'Scarlet & Violet', code: 'sv', totalCards: 258 },
                { name: 'Paldea Evolved', code: 'pal', totalCards: 279 }
            ],
            magic: [
                { name: 'The Lost Caverns of Ixalan', code: 'lci', totalCards: 400 },
                { name: 'Wilds of Eldraine', code: 'woe', totalCards: 375 }
            ],
            yugioh: [
                { name: 'Phantom Nightmare', code: 'phnm', totalCards: 100 },
                { name: 'Age of Overlord', code: 'agov', totalCards: 100 }
            ],
            lorcana: [
                { name: 'The First Chapter', code: 'tfc', totalCards: 204 },
                { name: 'Rise of the Floodborn', code: 'rof', totalCards: 204 }
            ],
            onepiece: [
                { name: 'Romance Dawn', code: 'op01', totalCards: 121 },
                { name: 'Paramount War', code: 'op02', totalCards: 121 }
            ]
        };
        
        return sets[game] || [];
    }
    
    getSampleImageUrl(game, setCode, cardNumber) {
        const placeholders = {
            pokemon: `https://via.placeholder.com/245x342/4B5563/FFFFFF?text=Pokemon+${cardNumber}`,
            magic: `https://via.placeholder.com/223x310/2D3748/FFFFFF?text=MTG+${cardNumber}`,
            yugioh: `https://via.placeholder.com/421x614/1A202C/FFFFFF?text=YGO+${cardNumber}`,
            lorcana: `https://via.placeholder.com/245x342/553C9A/FFFFFF?text=Lorcana+${cardNumber}`,
            onepiece: `https://via.placeholder.com/245x342/DC2626/FFFFFF?text=OP+${cardNumber}`
        };
        
        return placeholders[game] || `https://via.placeholder.com/245x342/718096/FFFFFF?text=Card+${cardNumber}`;
    }
    
    getRandomRarity() {
        const rarities = ['Common', 'Uncommon', 'Rare', 'Ultra Rare', 'Secret Rare'];
        return rarities[Math.floor(Math.random() * rarities.length)];
    }
    
    getCardType(game) {
        const types = {
            pokemon: ['Pokemon', 'Trainer', 'Energy'],
            magic: ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land'],
            yugioh: ['Monster', 'Spell', 'Trap'],
            lorcana: ['Character', 'Action', 'Item', 'Location'],
            onepiece: ['Character', 'Event', 'Stage', 'Leader']
        };
        
        const gameTypes = types[game] || ['Card'];
        return gameTypes[Math.floor(Math.random() * gameTypes.length)];
    }
    
    getGameAttributes(game) {
        const attributes = {
            pokemon: {
                hp: Math.floor(Math.random() * 200) + 50,
                type: ['Fire', 'Water', 'Grass', 'Electric', 'Psychic'][Math.floor(Math.random() * 5)],
                retreatCost: Math.floor(Math.random() * 4)
            },
            magic: {
                manaCost: '{' + Math.floor(Math.random() * 5) + '}',
                power: Math.floor(Math.random() * 10),
                toughness: Math.floor(Math.random() * 10)
            },
            yugioh: {
                attack: Math.floor(Math.random() * 3000),
                defense: Math.floor(Math.random() * 3000),
                level: Math.floor(Math.random() * 12) + 1
            }
        };
        
        return attributes[game] || {};
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // Parse methods for different games
    parsePokemonCard(data) {
        return data;
    }
    
    parseMagicCard(data) {
        return data;
    }
    
    parseYugiohCard(data) {
        return data;
    }
    
    parseLorcanaCard(data) {
        return data;
    }
    
    parseOnePieceCard(data) {
        return data;
    }
}

module.exports = TCGApi;