// src/tcg-api.js - CardCast TCG API with Local Image Caching
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
            // First, fetch all available sets to get the most recent ones
            progressCallback({ 
                status: 'fetching', 
                percent: 5, 
                message: 'Fetching available Pokemon sets...'
            });
            
            let allSets = [];
            try {
                const setsResponse = await axios.get('https://api.pokemontcg.io/v2/sets', {
                    params: {
                        orderBy: '-releaseDate', // Order by newest first
                        pageSize: 250
                    },
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'CardCast/1.0.0',
                        'Accept': 'application/json'
                    }
                });
                
                if (setsResponse.data && setsResponse.data.data) {
                    allSets = setsResponse.data.data;
                    console.log(`Found ${allSets.length} Pokemon sets`);
                }
            } catch (setsError) {
                console.error('Error fetching Pokemon sets:', setsError.message);
                // Fall back to hardcoded recent sets if API fails
                allSets = [
                    { id: 'sv8', name: 'Surging Sparks' },
                    { id: 'sv7', name: 'Stellar Crown' },
                    { id: 'sv6', name: 'Twilight Masquerade' },
                    { id: 'sv5', name: 'Temporal Forces' },
                    { id: 'sv4', name: 'Paradox Rift' },
                    { id: 'sv3', name: 'Obsidian Flames' },
                    { id: 'sv2', name: 'Paldea Evolved' },
                    { id: 'sv1', name: 'Scarlet & Violet' }
                ];
            }
            
            // Determine which sets to fetch based on setCount
            let setsToFetch = [];
            if (setCount === 'all') {
                setsToFetch = allSets;
            } else {
                const count = parseInt(setCount) || 3;
                setsToFetch = allSets.slice(0, count);
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
                                    const cardData = {
                                        id: `pokemon_${card.id}`,
                                        game: 'pokemon',
                                        name: card.name,
                                        set_name: card.set?.name || set.name,
                                        set_code: card.set?.id || set.id,
                                        card_number: card.number || '',
                                        image_url: card.images?.large || card.images?.small || '',
                                        rarity: card.rarity || 'Common',
                                        card_type: card.supertype || 'Pokemon',
                                        card_text: this.buildPokemonText(card),
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
                            console.log(`Waiting 3 seconds before retry...`);
                            await this.delay(3000);
                        }
                    }
                }
                
                if (!success) {
                    console.log(`Skipping set ${set.id} after all retries failed`);
                }
                
                await this.delay(200); // Rate limiting between sets
            }
            
            // Convert map to array
            cards.push(...cardMap.values());
            console.log(`Total unique Pokemon cards fetched: ${cards.length}`);
            
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
            if (setCount === 'all') {
                // For Magic, limit to last 20 sets for "all" to be reasonable
                setsToFetch = allSets.slice(0, 20);
            } else {
                const count = parseInt(setCount) || 3;
                setsToFetch = allSets.slice(0, count);
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
                                        card_number: card.collector_number || '',
                                        image_url: card.image_uris?.normal || card.image_uris?.small || card.card_faces?.[0]?.image_uris?.normal || '',
                                        rarity: card.rarity || 'common',
                                        card_type: card.type_line || '',
                                        card_text: card.oracle_text || card.card_faces?.[0]?.oracle_text || '',
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
            
            // For YuGiOh, we'll fetch based on the number requested
            const cardLimit = setCount === 'all' ? 500 : parseInt(setCount) * 50 || 100;
            
            const params = incremental ? {
                num: Math.min(cardLimit, 100),
                offset: 0,
                sort: 'new'
            } : {
                staple: 'yes',
                num: Math.min(cardLimit, 500),
                offset: 0
            };
            
            const response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                params: params,
                timeout: 30000,
                headers: {
                    'User-Agent': 'CardCast/1.0.0'
                }
            });
            
            if (response.data && response.data.data) {
                console.log(`YuGiOh: Got ${response.data.data.length} cards`);
                response.data.data.forEach(card => {
                    cards.push({
                        id: `yugioh_${card.id}`,
                        game: 'yugioh',
                        name: card.name,
                        set_name: card.card_sets?.[0]?.set_name || '',
                        set_code: card.card_sets?.[0]?.set_code || '',
                        card_number: card.card_sets?.[0]?.set_code || '',
                        image_url: card.card_images?.[0]?.image_url || '',
                        rarity: card.card_sets?.[0]?.set_rarity || 'Common',
                        card_type: card.type || '',
                        card_text: card.desc || '',
                        attributes: {
                            attack: card.atk || null,
                            defense: card.def || null,
                            level: card.level || null,
                            attribute: card.attribute || '',
                            race: card.race || ''
                        }
                    });
                });
            }
        } catch (error) {
            console.error('Error fetching Yu-Gi-Oh! cards:', error.message);
            if (cards.length === 0 && !incremental) {
                throw error;
            }
        }
        
        return cards;
    }
    
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
                // Don't throw error, just log it
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