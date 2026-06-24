// src/tcg-api.js - Fixed CardCast TCG API with Proper Incremental Updates
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const GundamScraper = require('./scrapers/gundam-scraper');

class TCGApi {
    constructor(database, options = {}) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        // Optional API keys (resolved by the caller: env > config.local.json > none).
        this.pokemonApiKey = options.pokemonApiKey || null;
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
        const games = ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'fab', 'starwars', 'gundam'];
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
                apiUrl: 'https://api.lorcast.com/v0',
                parseCard: this.parseLorcanaCard.bind(this)
            },
            digimon: {
                name: 'Digimon Card Game',
                apiUrl: 'https://digimoncard.io/api-public/search.php',
                parseCard: this.parseDigimonCard.bind(this)
            },
            onepiece: {
                name: 'One Piece Card Game',
                apiUrl: 'https://optcgapi.com/api',
                parseCard: this.parseOnePieceCard.bind(this)
            },
            gundam: {
                // No public API: cards are scraped from the official site instead.
                name: 'Gundam Card Game',
                apiUrl: 'https://www.gundam-gcg.com/en/cards',
                parseCard: this.parseGundamCard.bind(this)
            }
        };

        // Scraper for the Gundam Card Game (no JSON API available).
        this.gundamScraper = new GundamScraper();
    }

    // Build headers for api.pokemontcg.io. The X-Api-Key header is only sent
    // when a key is configured; without it the API works anonymously.
    pokemonHeaders() {
        const headers = {
            'User-Agent': 'CardCast/1.0.0',
            'Accept': 'application/json'
        };
        if (this.pokemonApiKey) {
            headers['X-Api-Key'] = this.pokemonApiKey;
        }
        return headers;
    }

    // Derive a file extension from an image URL (ignoring any query string),
    // defaulting to .jpg. Keeps Lorcana AVIF as .avif, Pokemon PNG as .png, etc.,
    // so cached images are served with a correct content type.
    getImageExtension(url) {
        try {
            const clean = String(url).split('?')[0].split('#')[0];
            const match = clean.match(/\.(jpe?g|png|avif|webp|gif)$/i);
            return match ? `.${match[1].toLowerCase()}` : '.jpg';
        } catch (e) {
            return '.jpg';
        }
    }

    // Transliterate a value to an ASCII-safe filename fragment. Accented letters
    // are decomposed (NFKD) and their combining marks dropped (e.g. "e" with an
    // acute -> "e"), then any run of non [A-Za-z0-9] collapses to one underscore
    // and leading/trailing underscores are trimmed. Returns '' for empty input.
    sanitizeFilenamePart(value) {
        return String(value == null ? '' : value)
            .normalize('NFKD')
            .replace(/\p{Diacritic}/gu, '')     // strip diacritic combining marks
            .replace(/[^A-Za-z0-9]+/g, '_')     // anything unsafe -> underscore
            .replace(/^_+|_+$/g, '');           // trim edge underscores
    }

    // Build a readable, ASCII-safe, unique cache filename for a card image:
    //   <setCode>_<cardNumber>_<cardName>__<id>.<ext>
    // Each part is transliterated/stripped and length-capped; the trailing __<id>
    // guarantees uniqueness (alternate arts share the same set + number). This is
    // shared by live downloads and seed mode so the /cache web path is identical
    // either way. The extension comes from the remote URL so content types stay
    // correct (Pokemon PNG, Lorcana AVIF, etc.).
    buildImageFilename(card, game) {
        const ext = this.getImageExtension(card.image_url || card.source_image_url || '');
        const setCode = this.sanitizeFilenamePart(card.set_code).slice(0, 16);
        const cardNumber = this.sanitizeFilenamePart(card.card_number).slice(0, 16);
        const cardName = this.sanitizeFilenamePart(card.name).slice(0, 40);
        const id = this.sanitizeFilenamePart(card.id).slice(0, 64);

        const readable = [setCode, cardNumber, cardName].filter(Boolean).join('_');
        const base = readable ? `${readable}__${id}` : id;
        return `${base}${ext}`;
    }

    // GET with retry + backoff. A 404 is rethrown immediately so callers can treat
    // it as "skip this set" rather than retrying a known-empty resource.
    async getWithRetry(url, options = {}, retries = 3) {
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await axios.get(url, options);
            } catch (error) {
                lastError = error;
                if (error.response && error.response.status === 404) throw error;
                if (attempt < retries) await this.delay(2000 * attempt);
            }
        }
        throw lastError;
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
    
    async downloadGameData(game, progressCallback, incremental = false, setCount = 'all', options = {}) {
        const skipImages = !!options.skipImages;
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
                    // Seed mode never writes image bytes and shares the cache dir
                    // with the live app, so do not wipe the user's cached images.
                    if (!skipImages) {
                        this.clearGameImages(game);
                    }
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
                case 'lorcana':
                    cards = await this.fetchLorcanaCards(progressCallback, incremental, setCount);
                    break;
                case 'digimon':
                    cards = await this.fetchDigimonCards(progressCallback, incremental, setCount);
                    break;
                case 'onepiece':
                    cards = await this.fetchOnePieceCards(progressCallback, incremental, setCount);
                    break;
                case 'gundam':
                    cards = await this.fetchGundamCards(progressCallback, incremental, setCount);
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
                // Download images for cards (seed mode assigns paths without bytes)
                progressCallback({ status: 'downloading', percent: 70, message: `Downloading images for ${cards.length} cards...` });
                await this.downloadCardImages(cards, game, progressCallback, options);
                
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
            
            // Retry the initial sets request the same way the per-set card loop does;
            // this call used to time out intermittently with no retry.
            let setsResponse = null;
            let setRetries = 3;
            while (setRetries > 0 && !setsResponse) {
                try {
                    setsResponse = await axios.get('https://api.pokemontcg.io/v2/sets', {
                        params: {
                            orderBy: '-releaseDate',
                            pageSize: 250
                        },
                        timeout: 60000,
                        headers: this.pokemonHeaders()
                    });
                } catch (setsError) {
                    setRetries--;
                    console.error(`Error fetching Pokemon sets, retries left ${setRetries}:`, setsError.message);
                    if (setRetries > 0) {
                        await this.delay(3000);
                    } else {
                        throw setsError;
                    }
                }
            }

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
                            headers: this.pokemonHeaders()
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
                        headers: this.pokemonHeaders()
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

    // Full MTG library via Scryfall's bulk data. The per-set search endpoint rate
    // limits hard across ~900 sets (429 -> skipped sets -> partial pull), so for a
    // whole-library pull we download the single "default_cards" bulk file (every
    // English/default printing) in one request and filter it locally. Scryfall
    // recommends bulk for exactly this. Returns parsed cards, mirroring the per-set
    // path's output so downloadGameData handles it identically.
    async fetchMagicBulkCards(incremental, progressCallback) {
        const headers = { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' };

        progressCallback({ status: 'fetching', percent: 5, message: 'Locating Scryfall bulk data...' });

        // 1. Resolve the default_cards bulk entry (every printing, English/default).
        const bulkList = await this.getWithRetry('https://api.scryfall.com/bulk-data', { timeout: 30000, headers });
        const entries = bulkList.data?.data || [];
        const defaultCards = entries.find(e => e.type === 'default_cards');
        if (!defaultCards || !defaultCards.download_uri) {
            throw new Error('Could not locate Scryfall default_cards bulk data');
        }

        const sizeMb = defaultCards.size ? ` (~${Math.round(defaultCards.size / 1024 / 1024)} MB)` : '';
        progressCallback({ status: 'downloading', percent: 15, message: `Downloading MTG bulk data${sizeMb}...` });

        // 2. Filter inline so we only retain cards we keep - mirrors the per-set
        //    filter (core/expansion/masters/draft_innovation, released, non-digital).
        const allowedTypes = new Set(['core', 'expansion', 'masters', 'draft_innovation']);
        const now = new Date();
        const downloaded = incremental ? this.getDownloadedSets('magic') : null;
        const cardMap = new Map();
        let processed = 0;

        const onCard = (card) => {
            processed++;
            if (processed % 20000 === 0) {
                progressCallback({
                    status: 'processing',
                    percent: Math.min(90, 30 + Math.floor(processed / 4000)),
                    message: `Processing cards... (${processed} scanned, ${cardMap.size} kept)`
                });
            }
            if (!allowedTypes.has(card.set_type)) return;
            if (card.digital) return; // skip Arena/MTGO-only printings
            if (card.released_at && new Date(card.released_at) > now) return;
            if (incremental && card.set && downloaded.has(card.set)) return;
            if (cardMap.has(card.id)) return;
            cardMap.set(card.id, this.parseMagicCard(card));
        };

        // 3. The decompressed default_cards JSON is larger than Node's max string
        //    length, so stream it and parse one top-level object at a time rather
        //    than buffering the whole array. axios decompresses the gzip stream.
        const response = await axios.get(defaultCards.download_uri, {
            responseType: 'stream',
            timeout: 300000,
            headers,
            decompress: true
        });

        await new Promise((resolve, reject) => {
            let buf = '';
            let i = 0, depth = 0, objStart = -1, inStr = false, esc = false;

            response.data.setEncoding('utf8');
            response.data.on('data', (chunk) => {
                buf += chunk;
                for (; i < buf.length; i++) {
                    const ch = buf[i];
                    if (inStr) {
                        if (esc) esc = false;
                        else if (ch === '\\') esc = true;
                        else if (ch === '"') inStr = false;
                        continue;
                    }
                    if (ch === '"') { inStr = true; continue; }
                    if (ch === '{') {
                        if (depth === 0) objStart = i;
                        depth++;
                    } else if (ch === '}') {
                        depth--;
                        if (depth === 0 && objStart >= 0) {
                            const objStr = buf.slice(objStart, i + 1);
                            try { onCard(JSON.parse(objStr)); } catch (e) { /* skip malformed */ }
                            // Drop the consumed prefix so buf stays ~one object.
                            buf = buf.slice(i + 1);
                            i = -1;
                            objStart = -1;
                        }
                    }
                }
            });
            response.data.on('end', resolve);
            response.data.on('error', reject);
        });

        const cards = [...cardMap.values()];
        console.log(`MTG bulk: kept ${cards.length} cards (${processed} scanned)`);
        progressCallback({ status: 'processing', percent: 90, message: `Prepared ${cards.length} MTG cards` });
        return cards;
    }

    async downloadMTGCards(incremental = false, setCount = 'all', progressCallback) {
        console.log(`Starting MTG download (${incremental ? 'incremental' : 'full'}, ${setCount} sets)...`);
        
        const cards = [];
        const cardMap = new Map();

        try {
            // For a whole-library pull, use Scryfall's bulk data (one download)
            // instead of per-set search. Searching ~900 sets individually rate
            // limits hard (429) and silently skips sets; bulk avoids that entirely.
            // Numeric setCount keeps the lightweight per-set path below.
            if (setCount === 'all') {
                return await this.fetchMagicBulkCards(incremental, progressCallback);
            }

            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching MTG sets from Scryfall...' });

            // Fetch all sets from Scryfall
            const setsResponse = await axios.get('https://api.scryfall.com/sets', {
                timeout: 30000,
                headers: { 'User-Agent': 'CardCast/1.0.0' }
            });
            
            if (!setsResponse.data || !setsResponse.data.data) {
                throw new Error('No sets data received from Scryfall API');
            }
            
            // Filter for main sets, drop sets that have no cards yet or are not
            // released. The newest Scryfall "set" is often an empty, future-dated
            // placeholder (card_count 0); searching it returns HTTP 404 and would
            // otherwise kill a 1-set download with "No cards were fetched".
            const now = new Date();
            let allSets = setsResponse.data.data
                .filter(set =>
                    set.set_type === 'core' ||
                    set.set_type === 'expansion' ||
                    set.set_type === 'masters' ||
                    set.set_type === 'draft_innovation'
                )
                .filter(set =>
                    (set.card_count || 0) > 0 &&
                    (!set.released_at || new Date(set.released_at) <= now)
                )
                .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));

            console.log(`Found ${allSets.length} released, non-empty MTG sets`);
            
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
                    setsToFetch = newSets; // honor "all": every new set
                } else {
                    const count = parseInt(setCount) || 3;
                    setsToFetch = newSets.slice(0, count);
                }
            } else {
                // Full download
                if (setCount === 'all') {
                    setsToFetch = allSets; // honor "all": every released, non-empty set
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
                    // Scryfall returns 404 when a search matches zero cards (an empty
                    // set). Treat that as "skip this set", not a hard failure.
                    if (setError.response && setError.response.status === 404) {
                        console.log(`Set ${set.code} has no cards on Scryfall, skipping`);
                    } else {
                        console.error(`Error fetching set ${set.code}:`, setError.message);
                    }
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

            // YGOPRODeck returns the whole card database from a single endpoint;
            // there is no per-set download here, so setCount acts as a volume control:
            //   'all'     -> the entire card database (large: ~13k cards + images)
            //   numeric N -> the N x 100 most recently released cards (sort=new)
            // misc=yes adds misc_info (formats/tcg_date) so we can drop OCG-only
            // (Japan-only) cards and keep English/TCG cards.
            const reqParams = { misc: 'yes' };
            if (setCount !== 'all') {
                const n = parseInt(setCount) || 3;
                reqParams.num = n * 100;
                reqParams.offset = 0;
                reqParams.sort = 'new';
            }

            // Retry with backoff like the other downloaders.
            let response = null;
            let retries = 3;
            while (retries > 0 && !response) {
                try {
                    response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                        params: reqParams,
                        timeout: 60000,
                        headers: {
                            'User-Agent': 'CardCast/1.0.0',
                            'Accept': 'application/json'
                        }
                    });
                } catch (reqError) {
                    retries--;
                    console.error(`Error fetching Yu-Gi-Oh! cards, retries left ${retries}:`, reqError.message);
                    if (retries > 0) {
                        await this.delay(3000);
                    } else {
                        throw reqError;
                    }
                }
            }

            if (response.data && Array.isArray(response.data.data)) {
                let list = response.data.data;
                console.log(`YuGiOh: API returned ${list.length} cards`);

                // English only: drop OCG-only (Japan-only) cards. A card is TCG/English
                // if it has a tcg_date or its formats include "TCG"; pure OCG cards have
                // neither (formats: ["OCG"], tcg_date: null).
                const before = list.length;
                list = list.filter(card => {
                    const misc = card.misc_info?.[0];
                    if (!misc) return true; // keep if no misc info rather than risk dropping valid cards
                    const formats = misc.formats;
                    return !!misc.tcg_date || (Array.isArray(formats) && formats.includes('TCG'));
                });
                console.log(`YuGiOh: ${list.length} TCG/English cards (dropped ${before - list.length} OCG-only)`);

                // Incremental: keep only cards whose (first) set isn't already stored.
                if (incremental) {
                    const downloaded = this.getDownloadedSets('yugioh');
                    list = list.filter(card => {
                        const setCode = card.card_sets?.[0]?.set_code || '';
                        return setCode && !downloaded.has(setCode);
                    });
                    console.log(`YuGiOh: ${list.length} cards after incremental filter`);
                    if (list.length === 0) {
                        return [];
                    }
                }

                list.forEach(card => cards.push(this.parseYugiohCardData(card)));
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
            product_id: String(card.id),
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

    // ---- Disney Lorcana (Lorcast - https://api.lorcast.com, free, no key) ----
    async fetchLorcanaCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];
        const cardMap = new Map();

        try {
            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching Lorcana sets...' });

            const setsResponse = await axios.get('https://api.lorcast.com/v0/sets', {
                timeout: 30000,
                headers: { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' }
            });

            // Lorcast wraps sets in a `results` array. Drop unreleased/future sets.
            const now = new Date();
            const allSets = (setsResponse.data?.results || [])
                .filter(set => set.released_at && new Date(set.released_at) <= now)
                .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));

            if (allSets.length === 0) {
                throw new Error('No released Lorcana sets received from API');
            }

            // Determine which sets to fetch (newest first).
            let setsToFetch = [];
            if (incremental) {
                const downloaded = this.getDownloadedSets('lorcana');
                const newSets = allSets.filter(set => !downloaded.has(set.code));
                if (newSets.length === 0) {
                    console.log('No new Lorcana sets available for incremental update');
                    return [];
                }
                setsToFetch = setCount === 'all' ? newSets : newSets.slice(0, parseInt(setCount) || 3);
            } else {
                setsToFetch = setCount === 'all' ? allSets : allSets.slice(0, parseInt(setCount) || 3);
            }

            console.log(`Lorcana: fetching ${setsToFetch.length} sets: ${setsToFetch.map(s => s.code).join(', ')}`);

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
                        const resp = await axios.get(`https://api.lorcast.com/v0/sets/${set.code}/cards`, {
                            timeout: 60000,
                            headers: { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' }
                        });
                        const list = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
                        console.log(`${set.name}: Got ${list.length} cards`);
                        list.forEach(card => {
                            if (!cardMap.has(card.id)) {
                                cardMap.set(card.id, this.parseLorcanaCardData(card, set));
                            }
                        });
                        success = true;
                    } catch (setError) {
                        if (setError.response && setError.response.status === 404) {
                            console.log(`Lorcana set ${set.code} has no cards, skipping`);
                            break;
                        }
                        retries--;
                        console.error(`Error fetching Lorcana set ${set.code}, retries left ${retries}:`, setError.message);
                        if (retries > 0) {
                            await this.delay(2000);
                        }
                    }
                }

                await this.delay(150);
            }

            cards.push(...cardMap.values());
            console.log(`Total Lorcana cards fetched: ${cards.length}`);
        } catch (error) {
            console.error('Error fetching Lorcana cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }

        return cards;
    }

    parseLorcanaCardData(card, set) {
        const name = card.version ? `${card.name} - ${card.version}` : card.name;
        const image = card.image_uris?.digital?.large ||
                      card.image_uris?.digital?.normal ||
                      card.image_uris?.digital?.small || '';
        const cardType = Array.isArray(card.type) ? card.type.join(' / ') : (card.type || '');
        const setCode = card.set?.code || set?.code || '';

        return {
            id: `lorcana_${card.id}`,
            game: 'lorcana',
            product_id: card.id,
            name,
            set_name: card.set?.name || set?.name || '',
            set_code: setCode,
            set_abbreviation: setCode ? setCode.toUpperCase() : null,
            card_number: card.collector_number || '',
            image_url: image,
            rarity: card.rarity || 'Common',
            card_type: cardType,
            card_text: card.text || '',
            // Shared color column = Lorcana ink. Lorcast gives `ink` (single) and
            // `inks` (array, for dual-ink cards). Decks are built from up to 2 inks,
            // so color identity needs this populated. Dual-ink joined with "/".
            colors: (Array.isArray(card.inks) && card.inks.length)
                ? card.inks.join('/')
                : (card.ink || null),
            // Lorcana-specific fields
            ink_cost: card.cost ?? null,
            strength: card.strength ?? null,
            willpower: card.willpower ?? null,
            lore_value: card.lore ?? null,
            inkable: card.inkwell ? 1 : 0
        };
    }

    // ---- Digimon (digimoncard.io public API, free, no key) ----
    async fetchDigimonCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];

        try {
            progressCallback({ status: 'downloading', percent: 30, message: 'Fetching Digimon cards...' });

            // digimoncard.io returns the whole series in a single response (no per-set
            // endpoint), so the set is derived from the card-number prefix (BT1-001 -> BT1)
            // and setCount limits how many of those sets we keep.
            let response = null;
            let retries = 3;
            while (retries > 0 && !response) {
                try {
                    response = await axios.get('https://digimoncard.io/api-public/search.php', {
                        params: { sort: 'name', sortdirection: 'asc', series: 'Digimon Card Game' },
                        timeout: 60000,
                        headers: { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' }
                    });
                } catch (reqError) {
                    retries--;
                    console.error(`Error fetching Digimon cards, retries left ${retries}:`, reqError.message);
                    if (retries > 0) {
                        await this.delay(3000);
                    } else {
                        throw reqError;
                    }
                }
            }

            if (!Array.isArray(response.data)) {
                if (!incremental) {
                    throw new Error('No Digimon cards received from API');
                }
                return [];
            }

            const setOf = (id) => {
                const match = String(id || '').match(/^([A-Za-z]+\d*)-/);
                return match ? match[1].toUpperCase() : 'OTHER';
            };

            let list = response.data;
            console.log(`Digimon: API returned ${list.length} cards`);

            // There is no per-set endpoint, so the whole series comes in one request.
            // We honor setCount by ordering sets via the per-set newest date_added and
            // keeping only the requested sets (this also bounds how many images download).
            const setDate = {};
            list.forEach(card => {
                const s = setOf(card.id);
                const d = card.date_added || '';
                if (!setDate[s] || d > setDate[s]) setDate[s] = d;
            });
            const setsByRecency = Object.keys(setDate).sort((a, b) => {
                if (setDate[a] === setDate[b]) return a < b ? 1 : -1;
                return setDate[a] < setDate[b] ? 1 : -1; // newest first
            });

            let allowedSets = null; // null = keep all
            if (incremental) {
                const downloaded = this.getDownloadedSets('digimon');
                const newSets = setsByRecency.filter(s => !downloaded.has(s));
                if (newSets.length === 0) {
                    console.log('No new Digimon sets for incremental update');
                    return [];
                }
                allowedSets = new Set(setCount === 'all' ? newSets : newSets.slice(0, parseInt(setCount) || 3));
            } else if (setCount !== 'all') {
                allowedSets = new Set(setsByRecency.slice(0, parseInt(setCount) || 3));
            }

            if (allowedSets) {
                console.log(`Digimon: limiting to ${allowedSets.size} newest sets: ${[...allowedSets].join(', ')}`);
                list = list.filter(card => allowedSets.has(setOf(card.id)));
            }

            // The API returns one row per printing, so the same card number (id)
            // can appear several times (alternate arts/rarities). Keep one per id.
            const seen = new Map();
            list.forEach(card => {
                if (!seen.has(card.id)) {
                    seen.set(card.id, this.parseDigimonCardData(card, setOf(card.id)));
                }
            });
            cards.push(...seen.values());
            console.log(`Total Digimon cards fetched: ${cards.length} unique (from ${list.length} printings)`);
        } catch (error) {
            console.error('Error fetching Digimon cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }

        return cards;
    }

    parseDigimonCardData(card, setCode) {
        const text = [
            card.main_effect || '',
            card.source_effect ? `[Inherited] ${card.source_effect}` : '',
            card.alt_effect || ''
        ].filter(Boolean).join('\n\n').trim();

        const setName = Array.isArray(card.set_name) ? card.set_name[0] : (card.set_name || '');

        return {
            id: `digimon_${card.id}`,
            game: 'digimon',
            product_id: card.id,
            name: card.name,
            set_name: setName,
            set_code: setCode,
            set_abbreviation: setCode,
            card_number: card.id,
            // The API exposes no image field; images live at a predictable host.
            image_url: `https://images.digimoncard.io/images/cards/${card.id}.jpg`,
            rarity: (card.rarity ? String(card.rarity).toUpperCase() : '') || 'Common',
            card_type: card.type || '',
            card_text: text,
            // Shared color column = the card's OWN color identity (color + optional
            // color2 for dual-color cards), slash-joined like the other games. This is
            // distinct from digivolve_color below, which is the color required to
            // digivolve INTO this card (card.evolution_color) - a different concept that
            // must not be conflated with the card's color for deck color identity.
            colors: card.color2 ? `${card.color}/${card.color2}` : (card.color || null),
            // Digimon-specific fields
            play_cost: card.play_cost ?? null,
            digivolve_cost: card.evolution_cost ?? null,
            digivolve_color: card.evolution_color || null,
            dp: card.dp ?? null,
            digimon_level: card.level ?? null,
            digimon_type: card.digi_type || null,
            digimon_attribute: card.attribute || null
        };
    }

    // ---- One Piece (optcgapi.com, free, no key) ----
    // Honors setCount like the other games:
    //   numeric N -> the N newest booster sets, fetched one set at a time (light on the
    //                API). /allSets/ is returned in release order, so newest = end.
    //   'all'     -> the entire pool (every booster set AND every starter deck) via the
    //                two bulk endpoints. Starter decks are only pulled on 'all'.
    async fetchOnePieceCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];
        const cardMap = new Map();
        const baseUrl = 'https://optcgapi.com/api';
        const headers = { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' };

        const addCard = (card) => {
            const key = card.card_set_id || card.card_image_id;
            if (key && !cardMap.has(key)) {
                cardMap.set(key, this.parseOnePieceCardData(card, null));
            }
        };

        try {
            if (setCount === 'all') {
                // Full pool: two bulk calls cover all booster sets and all starter decks.
                progressCallback({ status: 'fetching', percent: 10, message: 'Fetching One Piece cards (sets + starter decks)...' });
                const downloaded = incremental ? this.getDownloadedSets('onepiece') : null;
                const sources = [
                    { url: `${baseUrl}/allSetCards/`, label: 'booster sets' },
                    { url: `${baseUrl}/allSTCards/`, label: 'starter decks' }
                ];

                for (let s = 0; s < sources.length; s++) {
                    const src = sources[s];
                    progressCallback({
                        status: 'downloading',
                        percent: 15 + (s / sources.length) * 50,
                        message: `Fetching One Piece ${src.label}...`
                    });
                    const resp = await this.getWithRetry(src.url, { timeout: 60000, headers });
                    const list = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
                    console.log(`One Piece ${src.label}: got ${list.length} cards`);
                    list.forEach(card => {
                        if (incremental && card.set_id && downloaded.has(card.set_id)) return;
                        addCard(card);
                    });
                    await this.delay(200);
                }
            } else {
                // Numeric: the N newest booster sets, fetched individually.
                const n = parseInt(setCount) || 3;
                progressCallback({ status: 'fetching', percent: 5, message: 'Fetching One Piece sets...' });

                const setsResp = await this.getWithRetry(`${baseUrl}/allSets/`, { timeout: 30000, headers });
                // /allSets/ is in release order, so reverse for newest-first.
                let setIds = (Array.isArray(setsResp.data) ? setsResp.data : [])
                    .map(x => x.set_id)
                    .filter(Boolean)
                    .reverse();

                if (incremental) {
                    const downloaded = this.getDownloadedSets('onepiece');
                    setIds = setIds.filter(id => !downloaded.has(id));
                    if (setIds.length === 0) {
                        console.log('No new One Piece sets for incremental update');
                        return [];
                    }
                }

                const chosen = setIds.slice(0, n);
                console.log(`One Piece: fetching ${chosen.length} newest booster sets: ${chosen.join(', ')}`);

                for (let i = 0; i < chosen.length; i++) {
                    const setId = chosen[i];
                    progressCallback({
                        status: 'downloading',
                        percent: 10 + (i / chosen.length) * 60,
                        message: `Fetching ${setId} (${i + 1}/${chosen.length})...`
                    });
                    try {
                        const resp = await this.getWithRetry(`${baseUrl}/sets/${setId}/`, { timeout: 60000, headers });
                        const list = Array.isArray(resp.data) ? resp.data : (resp.data?.results || []);
                        console.log(`${setId}: got ${list.length} cards`);
                        list.forEach(addCard);
                    } catch (setError) {
                        if (setError.response && setError.response.status === 404) {
                            console.log(`One Piece set ${setId} has no cards, skipping`);
                        } else {
                            console.error(`Error fetching One Piece set ${setId}:`, setError.message);
                        }
                    }
                    await this.delay(200);
                }
            }

            cards.push(...cardMap.values());
            console.log(`Total One Piece cards fetched: ${cards.length}`);
        } catch (error) {
            console.error('Error fetching One Piece cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }

        return cards;
    }

    parseOnePieceCardData(card, group) {
        // Strip the trailing printing-number suffix from names, e.g. "Roronoa Zoro (001)".
        const name = (card.card_name || '').replace(/\s*\(\d+\)\s*$/, '').trim() || card.card_name || '';

        const setCode = card.set_id || group?.id || '';
        const text = card.card_text || '';

        // One Piece embeds DON!! requirements and Trigger effects inline in the text.
        const donMatch = text.match(/\[DON!!\s*x?(\d+)\]/i);
        const triggerMatch = text.match(/\[Trigger\]\s*(.+)$/is);

        const toInt = (value) => {
            const n = parseInt(value, 10);
            return Number.isNaN(n) ? null : n;
        };

        return {
            id: `onepiece_${card.card_set_id}`,
            game: 'onepiece',
            product_id: card.card_set_id,
            name,
            set_name: card.set_name || group?.name || '',
            set_code: setCode,
            set_abbreviation: setCode ? setCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null,
            card_number: card.card_set_id || '',
            image_url: card.card_image || '',
            rarity: card.rarity || 'C',
            card_type: card.card_type || '',
            card_text: text,
            // Shared color column. optcgapi exposes card_color (e.g. "Blue", or
            // space-joined "Green Red" for multicolor). Normalize multicolor to the
            // slash-joined form the other games use so cross-game color logic is
            // uniform. One Piece deck cards must share a color with the Leader.
            colors: card.card_color ? card.card_color.trim().replace(/\s+/g, '/') : null,
            // One Piece-specific fields
            cost: toInt(card.card_cost),
            op_power: toInt(card.card_power),
            counter: toInt(card.counter_amount),
            life: toInt(card.life),
            don_value: donMatch ? toInt(donMatch[1]) : null,
            trigger_text: triggerMatch ? triggerMatch[1].trim() : null
        };
    }

    // ---- Gundam Card Game (scraped from gundam-gcg.com, no public API) ----
    // The site exposes "packages" (sets); each is scraped for its cards. Honors
    // setCount and incremental like the API-backed games:
    //   'all'     -> every package, boosters AND starter/structure decks (the seed
    //                build and a full download use this). Bandai starter-deck cards
    //                are commonly played and shown on stream, so they are included.
    //   numeric N -> the N newest packages (by site order, newest first).
    async fetchGundamCards(progressCallback, incremental = false, setCount = 'all') {
        const cards = [];
        const cardMap = new Map();

        try {
            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching Gundam packages...' });

            let packages = await this.gundamScraper.getPackages();
            console.log(`Gundam: site lists ${packages.length} packages`);
            if (packages.length === 0) {
                if (!incremental) throw new Error('No Gundam packages found on the site');
                return [];
            }

            // The site lists packages oldest-first; reverse for newest-first so
            // numeric setCount and incremental prioritize the latest releases.
            packages = packages.slice().reverse();

            if (incremental) {
                const downloaded = this.getDownloadedSets('gundam');
                packages = packages.filter(pkg => pkg.code && !downloaded.has(pkg.code));
                if (packages.length === 0) {
                    console.log('No new Gundam packages for incremental update');
                    return [];
                }
            }

            if (setCount !== 'all') {
                const n = parseInt(setCount) || 3;
                packages = packages.slice(0, n);
            }

            console.log(`Gundam: scraping ${packages.length} packages: ${packages.map(p => p.code || p.name).join(', ')}`);

            for (let i = 0; i < packages.length; i++) {
                const pkg = packages[i];
                const basePercent = 10 + (i / packages.length) * 55;
                progressCallback({
                    status: 'downloading',
                    percent: Math.floor(basePercent),
                    message: `Fetching ${pkg.name} (${i + 1}/${packages.length})...`
                });

                try {
                    const rawCards = await this.gundamScraper.scrapePackage(pkg, {
                        onProgress: (done, total) => {
                            progressCallback({
                                status: 'downloading',
                                percent: Math.floor(basePercent + (done / total) * (55 / packages.length)),
                                message: `Fetching ${pkg.name}: ${done}/${total} cards...`
                            });
                        }
                    });
                    rawCards.forEach(rc => {
                        if (rc.product_id && !cardMap.has(rc.product_id)) {
                            cardMap.set(rc.product_id, this.parseGundamCardData(rc, pkg));
                        }
                    });
                } catch (pkgError) {
                    console.error(`Error scraping Gundam package ${pkg.code || pkg.name}:`, pkgError.message);
                }
            }

            cards.push(...cardMap.values());
            console.log(`Total Gundam cards fetched: ${cards.length}`);
        } catch (error) {
            console.error('Error fetching Gundam cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }

        return cards;
    }

    parseGundamCardData(raw, pkg) {
        const toInt = (value) => {
            const n = parseInt(value, 10);
            return Number.isNaN(n) ? null : n;
        };

        // Case-insensitive lookup of a scraped stat label (e.g. "Lv.", "AP").
        const fields = raw.fields || {};
        const fieldKeys = Object.keys(fields);
        const field = (label) => {
            const key = fieldKeys.find(k => k.toLowerCase() === label.toLowerCase());
            const value = key ? fields[key] : '';
            return value && value.trim() ? value.trim() : null;
        };

        // Set code comes from the package's bracket code, falling back to the card
        // number prefix (GD01-001 -> GD01).
        const setCode = (raw.set_code || (raw.card_number || '').split('-')[0] || '').toUpperCase();
        // A clean set name drops the trailing "[GD01]" code from the package label.
        const setName = (pkg?.name || raw.source_package || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

        // Card color is scraped from the site's COLOR stat. Stored in gd_color (the
        // Gundam-specific column) AND mirrored into the shared `colors` column so the
        // cross-game color-identity tooling can read color the same way for every game.
        // The site uses "-" for colorless cards (most Commands/Resources); map that to
        // null so `colors` stays empty for colorless, matching how Magic handles it.
        const gdColor = field('COLOR');
        const sharedColor = gdColor && gdColor !== '-' ? gdColor : null;

        return {
            id: `gundam_${raw.product_id}`,
            game: 'gundam',
            product_id: raw.product_id,
            name: raw.name,
            set_name: setName,
            set_code: setCode,
            set_abbreviation: setCode || null,
            card_number: raw.card_number || raw.product_id,
            image_url: raw.image || '',
            rarity: raw.rarity || '',
            card_type: field('TYPE') || '',
            card_text: raw.effect || '',
            colors: sharedColor,
            // Gundam-specific fields
            gd_level: toInt(field('Lv.')),
            gd_cost: toInt(field('COST')),
            gd_color: gdColor,
            gd_zone: field('Zone'),
            gd_trait: field('Trait'),
            gd_link: field('Link'),
            gd_ap: toInt(field('AP')),
            gd_hp: toInt(field('HP')),
            gd_source_title: field('Source Title'),
            gd_block_icon: raw.blockIcon || null,
            gd_sp: raw.sp || null
        };
    }

    // Rest of the methods remain the same...
    async downloadCardImages(cards, game, progressCallback, options = {}) {
        // Seed mode: assign each card the deterministic /cache web path and capture
        // its remote source URL, but download no image bytes. Each user's lazy image
        // middleware fetches the actual file on first view. local_image is left unset
        // because nothing is on disk yet.
        if (options.skipImages) {
            for (const card of cards) {
                if (!card.image_url) continue;
                if (!card.source_image_url) {
                    card.source_image_url = card.image_url;
                }
                const filename = this.buildImageFilename(card, game);
                card.image_url = `/cache/images/${game}/${filename}`;
            }
            progressCallback({
                status: 'downloading',
                percent: 90,
                message: `Prepared ${cards.length} image references (seed mode, no bytes)`
            });
            return;
        }

        const totalCards = cards.length;
        const downloadBatch = 10; // Download 10 images at a time
        let downloaded = 0;

        for (let i = 0; i < cards.length; i += downloadBatch) {
            const batch = cards.slice(i, i + downloadBatch);
            const promises = batch.map(async (card) => {
                if (card.image_url) {
                    // Capture the remote CDN URL once, before image_url is repointed
                    // at the local cache path. Never overwritten, so the self-healing
                    // cache can always re-fetch the original source later.
                    if (!card.source_image_url) {
                        card.source_image_url = card.image_url;
                    }

                    // Deterministic, readable cache filename (shared with seed mode).
                    const filename = this.buildImageFilename(card, game);
                    try {
                        const saved = await this.downloadImage(card.source_image_url, game, filename);
                        if (saved) {
                            // Store the cache location RELATIVE to the project root
                            // (portable across machines) and point image_url/display
                            // at the /cache web path served by Express.
                            card.local_image = `cache/images/${game}/${filename}`;
                            card.image_url = `/cache/images/${game}/${filename}`;
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
    
    // Download a single card image into cache/images/<game>/<filename>, skipping
    // the network fetch if it is already cached. The filename is precomputed by
    // buildImageFilename so it is readable and deterministic. Returns true once
    // the file exists on disk; returns false for empty/placeholder URLs and
    // throws (after retries) if the download fails so the caller can log it.
    async downloadImage(imageUrl, game, filename) {
        if (!imageUrl || imageUrl.includes('placeholder')) {
            return false;
        }

        const gameDir = path.join(this.imagesDir, game);
        if (!fs.existsSync(gameDir)) {
            fs.mkdirSync(gameDir, { recursive: true });
        }
        const imagePath = path.join(gameDir, filename);

        // Already cached
        if (fs.existsSync(imagePath)) {
            return true;
        }

        // Download with retry logic
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
                return true;
            } catch (error) {
                lastError = error;
                retries--;
                if (retries > 0) {
                    await this.delay(1000); // Wait 1 second before retry
                }
            }
        }

        throw lastError;
    }

    // Resolve a game's set codes ordered newest-first, using the same set listing
    // its downloader uses, so image pre-download can honor the user's set-count
    // choice ("Most recent set only", "Last 3 sets", ...). Returns an array of
    // set_codes (matching the DB's set_code column) newest-first, or null for games
    // with no set concept (Yu-Gi-Oh), whose count means "N x 100 newest cards".
    // Empty/blank codes are dropped (the Gundam site lists code-less promo/basic
    // "packages" first). Throws (via getWithRetry) if the listing can't be fetched,
    // so the caller surfaces an error rather than silently doing the wrong thing.
    async getOrderedSetCodes(game) {
        const headers = { 'User-Agent': 'CardCast/1.0.0', 'Accept': 'application/json' };
        const now = new Date();
        const clean = (arr) => arr.map(c => (c || '').toString()).filter(Boolean);

        switch (game) {
            case 'magic': {
                const resp = await this.getWithRetry('https://api.scryfall.com/sets', { timeout: 30000, headers });
                const sets = (resp.data?.data || [])
                    .filter(s => ['core', 'expansion', 'masters', 'draft_innovation'].includes(s.set_type))
                    .filter(s => (s.card_count || 0) > 0 && (!s.released_at || new Date(s.released_at) <= now))
                    .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));
                return clean(sets.map(s => s.code));
            }
            case 'pokemon': {
                const resp = await this.getWithRetry('https://api.pokemontcg.io/v2/sets',
                    { params: { orderBy: '-releaseDate', pageSize: 250 }, timeout: 30000, headers: this.pokemonHeaders() });
                const sets = (resp.data?.data || [])
                    .filter(s => s.series !== 'Other' && !s.name?.includes('Promo'))
                    .sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
                return clean(sets.map(s => s.id));
            }
            case 'lorcana': {
                const resp = await this.getWithRetry('https://api.lorcast.com/v0/sets', { timeout: 30000, headers });
                const sets = (resp.data?.results || [])
                    .filter(s => s.released_at && new Date(s.released_at) <= now)
                    .sort((a, b) => new Date(b.released_at) - new Date(a.released_at));
                return clean(sets.map(s => s.code));
            }
            case 'onepiece': {
                const resp = await this.getWithRetry('https://optcgapi.com/api/allSets/', { timeout: 30000, headers });
                const ids = (Array.isArray(resp.data) ? resp.data : []).map(x => x.set_id).reverse();
                return clean(ids);
            }
            case 'gundam': {
                const packages = (await this.gundamScraper.getPackages()).slice().reverse();
                return clean(packages.map(p => (p.code || '').toUpperCase()));
            }
            case 'digimon': {
                const resp = await this.getWithRetry('https://digimoncard.io/api-public/search.php',
                    { params: { sort: 'name', sortdirection: 'asc', series: 'Digimon Card Game' }, timeout: 60000, headers });
                const list = Array.isArray(resp.data) ? resp.data : [];
                const setOf = (id) => { const m = String(id || '').match(/^([A-Za-z]+\d*)-/); return m ? m[1].toUpperCase() : 'OTHER'; };
                const setDate = {};
                list.forEach(c => { const s = setOf(c.id); const d = c.date_added || ''; if (!setDate[s] || d > setDate[s]) setDate[s] = d; });
                const ordered = Object.keys(setDate).sort((a, b) => (setDate[a] === setDate[b] ? (a < b ? 1 : -1) : (setDate[a] < setDate[b] ? 1 : -1)));
                return clean(ordered);
            }
            default:
                return null; // Yu-Gi-Oh and others: no per-set listing
        }
    }

    // True if a manifest row's image is already on disk.
    isImageCached(game, row) {
        const filename = path.basename(row.image_url || '');
        if (!filename) return false;
        return fs.existsSync(path.join(this.imagesDir, game, filename));
    }

    // Pre-download cached images for a game that are not already on disk. Backs the
    // optional "pre-download all images" action so a streamer can warm the cache and
    // avoid any on-air hitch from lazy fetching. Honors setCount the same way the
    // downloader does: 'all' caches every card's image; a number selects the newest
    // N sets that still have uncached images (so if the most recent set is already
    // cached it moves on to the next, letting repeated clicks fill the cache
    // backwards). Yu-Gi-Oh has no sets, so a number means the newest N x 100 still-
    // uncached cards. Images already on disk are counted as skipped.
    async downloadAllImages(game, progressCallback, setCount = 'all') {
        let manifest = this.db.getImageManifest(game);

        if (setCount && setCount !== 'all') {
            const n = parseInt(setCount) || 1;
            const ordered = await this.getOrderedSetCodes(game);

            if (ordered === null) {
                // No set concept (Yu-Gi-Oh): the newest still-uncached cards by id.
                manifest = manifest
                    .slice()
                    .sort((a, b) => (parseInt(b.product_id) || 0) - (parseInt(a.product_id) || 0))
                    .filter(row => !this.isImageCached(game, row))
                    .slice(0, n * 100);
            } else {
                // Group the manifest by set, then walk sets newest-first and pick the
                // first N that still have at least one uncached image (fully-cached
                // sets are skipped so repeated runs make progress).
                const bySet = new Map();
                for (const row of manifest) {
                    if (!bySet.has(row.set_code)) bySet.set(row.set_code, []);
                    bySet.get(row.set_code).push(row);
                }
                const chosen = new Set();
                for (const code of ordered) {
                    const rows = bySet.get(code);
                    if (!rows || rows.length === 0) continue;          // set not in DB
                    if (rows.every(row => this.isImageCached(game, row))) continue; // fully cached
                    chosen.add(code);
                    if (chosen.size >= n) break;
                }
                manifest = manifest.filter(row => chosen.has(row.set_code));
            }
        }

        const total = manifest.length;
        const result = { total, downloaded: 0, skipped: 0, failed: 0 };

        if (total === 0) {
            progressCallback({ status: 'complete', percent: 100, message: 'No images to download', ...result });
            return result;
        }

        const batchSize = 10;
        let processed = 0;

        for (let i = 0; i < manifest.length; i += batchSize) {
            const batch = manifest.slice(i, i + batchSize);
            await Promise.all(batch.map(async (row) => {
                const filename = path.basename(row.image_url || '');
                if (!filename || !row.source_image_url) {
                    result.skipped++;
                    return;
                }
                const diskPath = path.join(this.imagesDir, game, filename);
                if (fs.existsSync(diskPath)) {
                    result.skipped++;
                    return;
                }
                try {
                    const saved = await this.downloadImage(row.source_image_url, game, filename);
                    if (saved) result.downloaded++;
                    else result.skipped++;
                } catch (err) {
                    result.failed++;
                }
            }));

            processed += batch.length;
            progressCallback({
                status: 'downloading',
                percent: Math.floor((processed / total) * 100),
                message: `Caching images... (${processed}/${total}) - ${result.downloaded} new, ${result.skipped} cached, ${result.failed} failed`,
                ...result
            });
        }

        progressCallback({
            status: 'complete',
            percent: 100,
            message: `Image cache ready: ${result.downloaded} downloaded, ${result.skipped} already cached, ${result.failed} failed`,
            ...result
        });
        return result;
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

    parseDigimonCard(data) {
        return data;
    }

    parseOnePieceCard(data) {
        return data;
    }

    parseGundamCard(data) {
        return data;
    }
}

module.exports = TCGApi;