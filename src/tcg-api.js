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

    async testMTGConnection() {
        try {
            console.log('Testing MTG API connection...');
            
            // Fetch a small sample from a known set
            const response = await axios.get('https://api.magicthegathering.io/v1/cards', {
                params: {
                    set: 'M21', // Core Set 2021
                    pageSize: 5
                }
            });
            
            console.log('✓ API Response Status:', response.status);
            console.log('✓ Rate Limit Remaining:', response.headers['ratelimit-remaining']);
            console.log('✓ Total Cards in Set:', response.headers['total-count']);
            console.log('✓ Cards in Response:', response.data.cards.length);
            console.log('\n--- Sample Card Structure ---');
            console.log(JSON.stringify(response.data.cards[0], null, 2));
            
            return { 
                success: true, 
                sampleCard: response.data.cards[0],
                rateLimit: response.headers['ratelimit-remaining'],
                totalCards: response.headers['total-count']
            };
        } catch (error) {
            console.error('✗ MTG API Connection Error:', error.message);
            if (error.response) {
                console.error('✗ Status:', error.response.status);
                console.error('✗ Data:', error.response.data);
            }
            return { success: false, error: error.message };
        }
    }

    async downloadMTGCards(incremental = false, setCount = 'all', progressCallback) {
        console.log(`Starting MTG download (${incremental ? 'incremental' : 'full'}, ${setCount} sets)...`);
        
        const cards = [];
        const cardMap = new Map();
        
        try {
            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching MTG sets from Scryfall...' });
            
            // Fetch all sets from Scryfall
            const setsResponse = await axios.get('https://api.scryfall.com/sets', {
                timeout: 30000,
                headers: { 'User-Agent': 'CardCast/1.0.0' }
            });
            
            if (!setsResponse.data || !setsResponse.data.data) {
                throw new Error('No sets data received from Scryfall API');
            }
            
            // Filter for main sets and sort by release date (most recent first)
            let allSets = setsResponse.data.data
                .filter(set => 
                    set.set_type === 'core' || 
                    set.set_type === 'expansion' || 
                    set.set_type === 'masters' ||
                    set.set_type === 'draft_innovation'
                )
                .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));
            
            console.log(`Found ${allSets.length} MTG sets`);
            
            // Determine which sets to download
            let setsToFetch = [];
            
            if (incremental) {
                const downloadedSets = this.getDownloadedSets('magic');
                console.log(`Already have ${downloadedSets.size} sets in database`);
                
                const newSets = allSets.filter(set => !downloadedSets.has(set.code));
                console.log(`Found ${newSets.length} new sets`);
                
                if (newSets.length === 0) {
                    console.log('No new sets for incremental update');
                    return [];
                }
                
                if (setCount === 'all') {
                    setsToFetch = newSets.slice(0, 10); // Limit to 10 newest
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = newSets.slice(0, count);
                }
            } else {
                // Full download
                if (setCount === 'all') {
                    setsToFetch = allSets.slice(0, 10); // Limit to 10 newest
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = allSets.slice(0, count);
                }
            }
            
            console.log(`Will fetch ${setsToFetch.length} sets: ${setsToFetch.map(s => s.code).join(', ')}`);
            
            // Fetch cards from each set
            for (let i = 0; i < setsToFetch.length; i++) {
                const set = setsToFetch[i];
                const percent = 10 + (i / setsToFetch.length) * 60;
                
                progressCallback({ 
                    status: 'downloading', 
                    percent: Math.floor(percent), 
                    message: `Fetching ${set.name} (${i + 1}/${setsToFetch.length})...`
                });
                
                try {
                    // Scryfall uses search endpoint with pagination
                    let searchUrl = `https://api.scryfall.com/cards/search?q=set:${set.code}&unique=prints&order=set`;
                    
                    while (searchUrl) {
                        const cardsResponse = await axios.get(searchUrl, {
                            timeout: 30000,
                            headers: { 'User-Agent': 'CardCast/1.0.0' }
                        });
                        
                        if (cardsResponse.data && cardsResponse.data.data) {
                            const setCards = cardsResponse.data.data;
                            console.log(`${set.name}: Got ${setCards.length} cards`);
                            
                            // Parse and add cards
                            setCards.forEach(card => {
                                if (!cardMap.has(card.id)) {
                                    const parsedCard = this.parseMagicCard(card);
                                    cardMap.set(card.id, parsedCard);
                                }
                            });
                            
                            // Check for next page
                            searchUrl = cardsResponse.data.has_more ? cardsResponse.data.next_page : null;
                        } else {
                            searchUrl = null;
                        }
                        
                        // Scryfall rate limit: 10 requests/second, so wait 100ms
                        await this.delay(100);
                    }
                    
                    console.log(`Completed ${set.name}: ${cardMap.size} total cards so far`);
                    
                } catch (setError) {
                    console.error(`Error fetching set ${set.code}:`, setError.message);
                    // Continue with other sets
                }
                
                // Wait between sets
                await this.delay(200);
            }
            
            // Convert map to array
            cards.push(...cardMap.values());
            console.log(`Total MTG cards fetched: ${cards.length}`);
            
            return cards;
            
        } catch (error) {
            console.error('Error downloading MTG cards:', error.message);
            throw error;
        }
    }
        
    async fetchMagicCards(progressCallback, incremental = false, setCount = 'all') {
        return await this.downloadMTGCards(incremental, setCount, progressCallback);
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
        try {
            // Scryfall provides comprehensive data
            const searchText = [
                data.name || '',
                data.type_line || '',
                data.oracle_text || '',
            ].join(' ').toLowerCase();
    
            // Handle double-faced cards (they have card_faces array)
            const frontFace = data.card_faces ? data.card_faces[0] : data;
            const imageUrl = data.image_uris?.normal || 
                            frontFace.image_uris?.normal || 
                            data.image_uris?.large ||
                            frontFace.image_uris?.large ||
                            null;
    
            const card = {
                id: `magic_${data.id}`,
                game: 'magic',
                product_id: data.id || null,
                name: data.name || 'Unknown Card',
                
                // MTG-specific: mana cost and CMC
                mana_cost: data.mana_cost || frontFace.mana_cost || null,
                cmc: data.cmc || 0,
                
                // Card type information
                card_type: data.type_line || '',
                type_line: data.type_line || '',
                
                // Power/Toughness for creatures, Loyalty for planeswalkers
                power: data.power || null,
                toughness: data.toughness || null,
                loyalty: data.loyalty || null,
                
                // Set information
                rarity: data.rarity || 'common',
                set_code: data.set || '',
                set_name: data.set_name || '',
                set_abbreviation: (data.set || '').toUpperCase(),
                card_number: data.collector_number || '',
                
                // Image - Scryfall always provides images
                image_url: imageUrl,
                
                // Text
                card_text: data.oracle_text || frontFace.oracle_text || null,
                oracle_text: data.oracle_text || frontFace.oracle_text || null,
                flavor_text: data.flavor_text || null,
                artist: data.artist || null,
                
                // Colors
                colors: data.colors ? data.colors.join(',') : '',
                color_identity: data.color_identity ? data.color_identity.join(',') : '',
                
                // Store additional data
                attributes: {
                    colors: data.colors || [],
                    colorIdentity: data.color_identity || [],
                    legalities: data.legalities || {},
                    layout: data.layout || 'normal',
                    manaCost: data.mana_cost || frontFace.mana_cost || null,
                    cmc: data.cmc || 0,
                    power: data.power || null,
                    toughness: data.toughness || null,
                    loyalty: data.loyalty || null,
                    keywords: data.keywords || [],
                    prices: data.prices || {}
                }
            };
    
            return card;
        } catch (error) {
            console.error('Error parsing MTG card:', data.name || 'unknown', error);
            throw error;
        }
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