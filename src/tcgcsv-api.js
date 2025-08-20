// src/tcgcsv-api.js - TCGCSV.com Product Data API
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class TCGCSVApi {
    constructor(database) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        this.apiUrl = 'https://api.tcgcsv.com'; // If they have a separate API endpoint
        this.cacheDir = path.join(__dirname, '..', 'cache');
        this.imagesDir = path.join(__dirname, '..', 'cache', 'images');
        
        // Ensure directories exist
        [this.cacheDir, this.imagesDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
        
        // Create game-specific image directories
        const games = ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'digimon', 'fab', 'starwars'];
        games.forEach(game => {
            const gameDir = path.join(this.imagesDir, game);
            if (!fs.existsSync(gameDir)) {
                fs.mkdirSync(gameDir, { recursive: true });
            }
        });
        
        // TCGCSV Category IDs
        this.categories = {
            pokemon: { id: 3, name: 'Pokemon' },
            magic: { id: 1, name: 'Magic' },
            yugioh: { id: 2, name: 'YuGiOh' },
            lorcana: { id: 71, name: 'Lorcana TCG' },
            onepiece: { id: 68, name: 'One Piece Card Game' },
            digimon: { id: 63, name: 'Digimon Card Game' },
            fab: { id: 62, name: 'Flesh & Blood TCG' },
            starwars: { id: 79, name: 'Star Wars Unlimited' }
        };
        
        // Known recent Pokemon sets with their group IDs
        this.knownPokemonSets = [
            { groupId: 24380, name: 'ME01: Mega Evolution', abbreviation: 'ME01' },
            { groupId: 24326, name: 'SV: White Flare', abbreviation: 'SVW' },
            { groupId: 24325, name: 'SV: Black Bolt', abbreviation: 'SVB' },
            { groupId: 24324, name: 'SV: Surging Sparks', abbreviation: 'SV08' },
            { groupId: 24323, name: 'SV: Stellar Crown', abbreviation: 'SV07' },
            { groupId: 24322, name: 'SV: Shrouded Fable', abbreviation: 'SV06.5' },
            { groupId: 24321, name: 'SV: Twilight Masquerade', abbreviation: 'SV06' },
            { groupId: 24320, name: 'SV: Temporal Forces', abbreviation: 'SV05' },
            { groupId: 24319, name: 'SV: Paradox Rift', abbreviation: 'SV04' },
            { groupId: 24318, name: 'SV: Obsidian Flames', abbreviation: 'SV03' },
            { groupId: 24317, name: 'SV: Paldea Evolved', abbreviation: 'SV02' },
            { groupId: 24316, name: 'SV: Scarlet & Violet', abbreviation: 'SV01' },
            { groupId: 24315, name: 'SV: Black Star Promos', abbreviation: 'SVP' }
        ];
    }
    
    async downloadGameData(game, progressCallback, incremental = false, setCount = 'all') {
        const category = this.categories[game];
        if (!category) {
            throw new Error(`Unsupported game: ${game}`);
        }
        
        console.log(`Starting ${incremental ? 'incremental' : 'full'} download for ${category.name}...`);
        progressCallback({ status: 'starting', percent: 0, message: 'Preparing download...' });
        
        try {
            // Clear existing data if not incremental
            if (!incremental) {
                this.db.clearGameData(game);
            }
            
            // Get all available groups/sets
            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching available sets...' });
            const allGroups = await this.getGroupsForGame(game, category.id);
            
            // Determine which groups to download
            let groupsToFetch = [];
            
            if (incremental) {
                // For incremental updates, find sets we don't have yet
                const downloadedSets = await this.getDownloadedSets(game);
                console.log(`Already have ${downloadedSets.size} sets downloaded`);
                
                // Filter out sets we already have
                const missingSets = allGroups.filter(group => !downloadedSets.has(group.groupId.toString()));
                console.log(`Found ${missingSets.length} sets not yet downloaded`);
                
                if (setCount === 'all') {
                    groupsToFetch = missingSets;
                } else {
                    const count = parseInt(setCount) || 3;
                    // Get the next 'count' sets we don't have
                    groupsToFetch = missingSets.slice(0, count);
                }
                
                if (groupsToFetch.length === 0) {
                    console.log('All available sets are already downloaded');
                    progressCallback({ status: 'complete', percent: 100, message: 'All sets already up to date!' });
                    return 0;
                }
            } else {
                // For full download, just take from the top
                if (setCount === 'all') {
                    groupsToFetch = allGroups;
                } else {
                    const count = parseInt(setCount) || 3;
                    groupsToFetch = allGroups.slice(0, count);
                }
            }
            
            console.log(`Will fetch ${groupsToFetch.length} sets: ${groupsToFetch.map(g => g.name).join(', ')}`);
            
            // Download cards from each group
            const allCards = [];
            for (let i = 0; i < groupsToFetch.length; i++) {
                const group = groupsToFetch[i];
                progressCallback({ 
                    status: 'downloading', 
                    percent: 10 + (i / groupsToFetch.length) * 60, 
                    message: `Downloading ${group.name} (${i + 1}/${groupsToFetch.length})...`
                });
                
                try {
                    const products = await this.fetchGroupProducts(category.id, group);
                    
                    // Filter out sealed products and non-cards
                    const cards = products.filter(p => this.isCard(p));
                    
                    console.log(`${group.name}: ${cards.length} cards out of ${products.length} products`);
                    allCards.push(...cards);
                } catch (groupError) {
                    console.error(`Error fetching group ${group.name}:`, groupError.message);
                    // Continue with other groups
                }
                
                // Small delay between groups to avoid rate limiting
                await this.delay(500);
            }
            
            console.log(`Total cards fetched: ${allCards.length}`);
            
            if (allCards.length === 0 && !incremental) {
                throw new Error('No cards were fetched');
            }
            
            // Process and save cards
            progressCallback({ status: 'processing', percent: 70, message: 'Processing card data...' });
            
            const processedCards = [];
            const cardMap = new Map();
            let skippedCount = 0;
            
            for (const product of allCards) {
                // Skip duplicates within this batch
                if (cardMap.has(product.productId)) {
                    continue;
                }
                
                // Check if card already exists in database (for incremental updates)
                if (incremental) {
                    const exists = this.db.cardExists(game, product.productId);
                    if (exists) {
                        skippedCount++;
                        continue; // Skip cards that already exist
                    }
                }
                
                const card = this.processProductToCard(product, game);
                if (card) {
                    cardMap.set(product.productId, card);
                    processedCards.push(card);
                }
            }
            
            console.log(`Processed ${processedCards.length} new cards (skipped ${skippedCount} existing)`);
            
            // Download images for new cards
            if (processedCards.length > 0) {
                progressCallback({ status: 'downloading', percent: 80, message: 'Downloading card images...' });
                await this.downloadCardImages(processedCards, game, progressCallback);
            }
            
            // Save to database
            progressCallback({ status: 'saving', percent: 90, message: 'Saving to database...' });
            
            if (processedCards.length > 0) {
                const batchSize = 100;
                for (let i = 0; i < processedCards.length; i += batchSize) {
                    const batch = processedCards.slice(i, i + batchSize);
                    
                    // Use skipExisting = true for incremental, false for full refresh
                    const results = this.db.bulkInsertCards(batch, incremental);
                    
                    const savePercent = 90 + (i / processedCards.length) * 10;
                    progressCallback({ 
                        status: 'saving', 
                        percent: Math.floor(savePercent), 
                        message: `Saving cards... (${Math.min(i + batchSize, processedCards.length)}/${processedCards.length})`
                    });
                }
            }
            
            // Update game info - let the database count the actual cards
            this.db.updateGameInfo(game);
            
            progressCallback({ status: 'complete', percent: 100, message: incremental ? 'Update complete!' : 'Download complete!' });
            
            const finalStats = this.db.getGameStats().find(g => g.id === game);
            console.log(`${incremental ? 'Added' : 'Downloaded'} ${processedCards.length} cards for ${category.name}. Total in database: ${finalStats?.card_count || 0}`);
            
            return processedCards.length;
        } catch (error) {
            console.error(`Error downloading ${game} data:`, error);
            throw error;
        }
    }
    
    async getGroupsForGame(game, categoryId) {
        try {
            // First try to fetch the actual groups from TCGCSV
            const groups = await this.fetchGroupsList(categoryId);
            if (groups.length > 0) {
                console.log(`Successfully fetched ${groups.length} groups for ${game}`);
                return groups;
            }
        } catch (error) {
            console.error(`Error fetching groups for ${game}:`, error.message);
        }
        
        // Fallback to known sets if fetch fails
        console.log(`Using fallback groups for ${game}`);
        
        if (game === 'pokemon') {
            return this.knownPokemonSets;
        }
        
        // Fallback groups for other games
        const fallbackGroups = {
            magic: [
                { groupId: 25001, name: 'Foundations', abbreviation: 'FDN' },
                { groupId: 25000, name: 'Duskmourn: House of Horror', abbreviation: 'DSK' },
                { groupId: 24999, name: 'Bloomburrow', abbreviation: 'BLB' }
            ],
            yugioh: [
                { groupId: 26001, name: 'The Infinite Forbidden', abbreviation: 'INFO' },
                { groupId: 26000, name: 'Legacy of Destruction', abbreviation: 'LEDE' },
                { groupId: 25999, name: 'Phantom Nightmare', abbreviation: 'PHNM' }
            ],
            lorcana: [
                { groupId: 27001, name: 'Azurite Sea', abbreviation: 'AZS' },
                { groupId: 27000, name: 'Shimmering Skies', abbreviation: 'SKY' },
                { groupId: 26999, name: 'Ursula\'s Return', abbreviation: 'UR' }
            ],
            onepiece: [
                { groupId: 28001, name: 'OP-09', abbreviation: 'OP09' },
                { groupId: 28000, name: 'OP-08', abbreviation: 'OP08' },
                { groupId: 27999, name: 'OP-07', abbreviation: 'OP07' }
            ]
        };
        
        return fallbackGroups[game] || [];
    }
    
    async fetchGroupsList(categoryId) {
        const groups = [];
        
        try {
            // The correct TCGCSV groups endpoint
            const endpoint = `${this.baseUrl}/tcgplayer/${categoryId}/groups`;
            console.log(`Fetching groups from: ${endpoint}`);
            
            const response = await axios.get(endpoint, {
                headers: {
                    'User-Agent': 'CardCast/1.0.0',
                    'Accept': 'application/json, text/html, */*'
                },
                timeout: 30000
            });
            
            if (response.data) {
                // Parse the response - it might be JSON or need parsing
                let data = response.data;
                
                if (Array.isArray(data)) {
                    // If it's already an array of groups
                    data.forEach(group => {
                        if (group.groupId || group['Group ID']) {
                            groups.push({
                                groupId: group.groupId || group['Group ID'],
                                name: group.name || group['Group Name'] || '',
                                abbreviation: group.abbreviation || group['Abbreviation'] || '',
                                categoryId: group.categoryId || group['Category ID'] || categoryId
                            });
                        }
                    });
                } else if (typeof data === 'object') {
                    // If it's an object with a results/groups array
                    const groupArray = data.results || data.groups || [];
                    groupArray.forEach(group => {
                        if (group.groupId || group['Group ID']) {
                            groups.push({
                                groupId: group.groupId || group['Group ID'],
                                name: group.name || group['Group Name'] || '',
                                abbreviation: group.abbreviation || group['Abbreviation'] || '',
                                categoryId: group.categoryId || group['Category ID'] || categoryId
                            });
                        }
                    });
                }
                
                console.log(`Found ${groups.length} groups for category ${categoryId}`);
                
                // Sort by groupId descending (newest first)
                groups.sort((a, b) => b.groupId - a.groupId);
            }
        } catch (error) {
            console.error(`Error fetching groups for category ${categoryId}:`, error.message);
        }
        
        return groups;
    }
    
    async fetchGroupProducts(categoryId, group) {
        const products = [];
        
        try {
            // The correct TCGCSV endpoint structure
            const endpoint = `${this.baseUrl}/tcgplayer/${categoryId}/${group.groupId}/products`;
            console.log(`Fetching products from: ${endpoint}`);
            
            const response = await axios.get(endpoint, {
                headers: {
                    'User-Agent': 'CardCast/1.0.0',
                    'Accept': 'application/json, text/html, */*',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive'
                },
                timeout: 60000,
                maxContentLength: 100 * 1024 * 1024, // 100MB max
                maxBodyLength: 100 * 1024 * 1024
            });
            
            if (response.data) {
                // The response should be a JSON array of products
                const data = Array.isArray(response.data) ? response.data : 
                           (response.data.results || response.data.products || []);
                
                console.log(`Received ${data.length} products from ${group.name}`);
                return data;
            }
            
        } catch (error) {
            console.error(`Error fetching products for group ${group.name}:`, error.message);
            
            // If the main endpoint fails, try alternate patterns
            try {
                const altEndpoint = `${this.baseUrl}/tcgplayer/${categoryId}/groups/${group.groupId}/products.json`;
                console.log(`Trying alternate endpoint: ${altEndpoint}`);
                
                const response = await axios.get(altEndpoint, {
                    headers: {
                        'User-Agent': 'CardCast/1.0.0',
                        'Accept': 'application/json'
                    },
                    timeout: 30000
                });
                
                if (response.data) {
                    return Array.isArray(response.data) ? response.data : [];
                }
            } catch (altError) {
                console.error(`Alternate endpoint also failed: ${altError.message}`);
            }
            
            // If real data fails, use sample data for testing
            console.log(`Using sample data for ${group.name}`);
            return this.generateSampleProducts(categoryId, group);
        }
        
        return products;
    }
    
    async getDownloadedSets(game) {
        // Query the database to find which sets we already have
        try {
            const stmt = this.db.db.prepare(`
                SELECT DISTINCT set_code 
                FROM cards 
                WHERE game = ? AND set_code IS NOT NULL AND set_code != ''
            `);
            
            const results = stmt.all(game);
            const downloadedSets = new Set();
            
            results.forEach(row => {
                if (row.set_code) {
                    downloadedSets.add(row.set_code);
                }
            });
            
            console.log(`Found ${downloadedSets.size} downloaded sets for ${game}: ${Array.from(downloadedSets).join(', ')}`);
            return downloadedSets;
        } catch (error) {
            console.error(`Error getting downloaded sets for ${game}:`, error);
            return new Set();
        }
    }
    
    isCard(product) {
        // Check if product is an actual card (not sealed product, accessories, etc.)
        
        // If extendedData exists, check for card-specific attributes
        if (product.extendedData && Array.isArray(product.extendedData)) {
            const extData = product.extendedData;
            
            // Look for CardText that indicates sealed product
            const cardText = extData.find(d => d.name === 'CardText');
            if (cardText && cardText.value) {
                const text = cardText.value.toLowerCase();
                if (text.includes('booster pack') || text.includes('binder') || 
                    text.includes('collection') || text.includes('deck box') ||
                    text.includes('sleeves') || text.includes('playmat')) {
                    return false; // It's a sealed product or accessory
                }
            }
            
            // Look for card-specific attributes
            const hasCardAttributes = extData.some(d => 
                ['HP', 'Attack 1', 'Attack 2', 'Stage', 'Card Type', 'Mana Cost', 
                 'Power', 'Toughness', 'ATK', 'DEF', 'Level'].includes(d.name)
            );
            
            if (hasCardAttributes) {
                return true; // Definitely a card
            }
        }
        
        // Check product name for sealed product keywords
        const name = (product.name || '').toLowerCase();
        const sealedKeywords = [
            'booster', 'box', 'case', 'pack', 'bundle', 'collection',
            'deck', 'tin', 'binder', 'sleeves', 'playmat', 'dice',
            'coin', 'marker', 'token', 'accessory', 'supplies'
        ];
        
        if (sealedKeywords.some(keyword => name.includes(keyword))) {
            // But allow "deck" if it's part of a card name like "Deck Master"
            if (name.includes('deck') && !name.includes('starter') && !name.includes('theme')) {
                // Check if it has a card number
                const hasNumber = product.extendedData?.find(d => d.name === 'Number');
                if (hasNumber) {
                    return true; // It's a card with "deck" in the name
                }
            }
            return false; // It's sealed product
        }
        
        // Default to true if we have a product ID and name
        return product.productId && product.name;
    }
    
    processProductToCard(product, game) {
        try {
            // Extract extended data into a map for easy access
            const extData = {};
            if (product.extendedData && Array.isArray(product.extendedData)) {
                product.extendedData.forEach(item => {
                    extData[item.name] = item.value;
                });
            }
            
            // Build base card object
            const card = {
                id: `${game}_${product.productId}`,
                game: game,
                product_id: product.productId,
                name: product.name || product.cleanName || 'Unknown Card',
                set_name: this.extractSetName(product, game),
                set_code: product.groupId?.toString() || '',
                card_number: extData['Number'] || '',
                image_url: this.fixImageUrl(product.imageUrl),
                rarity: extData['Rarity'] || 'Common',
                card_type: extData['Card Type'] || '',
                card_text: extData['Card Text'] || ''
            };
            
            // Add game-specific fields based on the game
            switch(game) {
                case 'pokemon':
                    // Parse Pokemon-specific fields
                    card.hp = parseInt(extData['HP']) || null;
                    card.stage = extData['Stage'] || null;
                    card.evolves_from = extData['Evolves From'] || null;
                    card.weakness = extData['Weakness'] || null;
                    card.resistance = extData['Resistance'] || null;
                    card.retreat_cost = extData['RetreatCost'] || extData['Retreat Cost'] || null;
                    
                    // Parse ability if present
                    if (extData['Ability']) {
                        const abilityParts = extData['Ability'].split(' - ');
                        card.ability_name = abilityParts[0] || null;
                        card.ability_text = abilityParts[1] || extData['Ability'];
                    }
                    
                    // For now, just store the attack data as-is from TCGCSV
                    // We'll parse it better when displaying in overlays
                    if (extData['Attack 1']) {
                        card.attack1_name = extData['Attack 1'];
                    }
                    if (extData['Attack 2']) {
                        card.attack2_name = extData['Attack 2'];
                    }
                    if (extData['Attack 3']) {
                        card.attack3_name = extData['Attack 3'];
                    }
                    break;
                    
                case 'magic':
                    card.mana_cost = extData['Mana Cost'] || null;
                    card.cmc = parseInt(extData['CMC'] || extData['Converted Mana Cost']) || null;
                    card.power = extData['Power'] || null;
                    card.toughness = extData['Toughness'] || null;
                    card.loyalty = parseInt(extData['Loyalty']) || null;
                    card.colors = extData['Colors'] || null;
                    card.color_identity = extData['Color Identity'] || null;
                    card.type_line = extData['Type'] || extData['Type Line'] || null;
                    card.oracle_text = extData['Oracle Text'] || extData['Card Text'] || null;
                    card.flavor_text = extData['Flavor Text'] || null;
                    break;
                    
                case 'yugioh':
                    card.attack = parseInt(extData['ATK'] || extData['Attack']) || null;
                    card.defense = parseInt(extData['DEF'] || extData['Defense']) || null;
                    card.level = parseInt(extData['Level']) || null;
                    card.rank = parseInt(extData['Rank']) || null;
                    card.link_value = parseInt(extData['Link']) || null;
                    card.pendulum_scale = parseInt(extData['Pendulum Scale']) || null;
                    card.attribute = extData['Attribute'] || null;
                    card.monster_type = extData['Type'] || extData['Monster Type'] || null;
                    break;
                    
                case 'lorcana':
                    card.ink_cost = parseInt(extData['Ink Cost']) || null;
                    card.strength = parseInt(extData['Strength']) || null;
                    card.willpower = parseInt(extData['Willpower']) || null;
                    card.lore_value = parseInt(extData['Lore']) || null;
                    card.inkable = extData['Inkable'] === 'Yes' || extData['Inkable'] === 'true';
                    break;
                    
                case 'onepiece':
                    card.cost = parseInt(extData['Cost']) || null;
                    card.op_power = parseInt(extData['Power']) || null;
                    card.counter = parseInt(extData['Counter']) || null;
                    card.life = parseInt(extData['Life']) || null;
                    card.don_value = parseInt(extData['DON!!']) || null;
                    card.trigger_text = extData['Trigger'] || null;
                    break;
                    
                case 'digimon':
                    card.play_cost = parseInt(extData['Play Cost']) || null;
                    card.digivolve_cost = parseInt(extData['Digivolve Cost']) || null;
                    card.digivolve_color = extData['Digivolve Color'] || null;
                    card.dp = parseInt(extData['DP']) || null;
                    card.digimon_level = parseInt(extData['Level']) || null;
                    card.digimon_type = extData['Type'] || null;
                    card.digimon_attribute = extData['Attribute'] || null;
                    break;
                    
                case 'fab':
                    card.pitch_value = parseInt(extData['Pitch']) || null;
                    card.fab_defense = parseInt(extData['Defense']) || null;
                    card.fab_attack = parseInt(extData['Attack']) || null;
                    card.resource_cost = parseInt(extData['Resource Cost']) || null;
                    break;
                    
                case 'starwars':
                    card.sw_cost = parseInt(extData['Cost']) || null;
                    card.sw_power = parseInt(extData['Power']) || null;
                    card.sw_hp = parseInt(extData['HP']) || null;
                    card.aspect = extData['Aspect'] || null;
                    card.arena = extData['Arena'] || null;
                    break;
            }
            
            return card;
        } catch (error) {
            console.error('Error processing product to card:', error);
            return null;
        }
    }
    
    extractSetName(product, game) {
        // Try to get set name from URL or group info
        if (product.url) {
            const urlParts = product.url.split('/');
            if (game === 'pokemon' && urlParts.length > 4) {
                // URL format: .../pokemon-sv-black-bolt-snivy
                const setPart = urlParts[4]; // pokemon-sv-black-bolt-snivy
                const setParts = setPart.split('-');
                if (setParts[0] === 'pokemon') {
                    // Remove 'pokemon' and card name, reconstruct set name
                    setParts.shift(); // Remove 'pokemon'
                    setParts.pop(); // Remove card name
                    return setParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
                }
            }
        }
        
        // Fallback to group name
        return product.groupName || '';
    }
    
    fixImageUrl(imageUrl) {
        if (!imageUrl) return '';
        
        // Convert low-res TCGPlayer CDN URLs to high-res
        // From: https://tcgplayer-cdn.tcgplayer.com/product/642450_200w.jpg
        // To: https://tcgplayer-cdn.tcgplayer.com/product/642450_in_1000x1000.jpg
        
        if (imageUrl.includes('tcgplayer-cdn.tcgplayer.com')) {
            // Remove any size suffix (_200w, _400w, etc.)
            imageUrl = imageUrl.replace(/_\d+w\.jpg$/i, '.jpg');
            // Remove .jpg and add high-res suffix
            imageUrl = imageUrl.replace(/\.jpg$/i, '_in_1000x1000.jpg');
        }
        
        // Ensure it's a full URL
        if (!imageUrl.startsWith('http')) {
            imageUrl = `https:${imageUrl}`;
        }
        
        return imageUrl;
    }
    
    generateSampleProducts(categoryId, group) {
        // Generate sample product data for testing
        const products = [];
        
        for (let i = 1; i <= 10; i++) {
            products.push({
                productId: `${group.groupId}_${i}`,
                name: `${group.name} Card ${i}`,
                cleanName: `${group.name} Card ${i}`,
                imageUrl: `https://via.placeholder.com/367x512/4B5563/FFFFFF?text=Card+${i}`,
                categoryId: categoryId,
                groupId: group.groupId,
                url: '',
                extendedData: [
                    { name: 'Number', value: `${i}/100` },
                    { name: 'Rarity', value: i <= 7 ? 'Common' : i <= 9 ? 'Uncommon' : 'Rare' },
                    { name: 'Card Type', value: 'Pokemon' },
                    { name: 'HP', value: `${60 + i * 10}` },
                    { name: 'Stage', value: 'Basic' }
                ]
            });
        }
        
        return products;
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    parseAttack(attackString) {
        // Parse Pokemon attack format
        const result = {
            name: '',
            cost: '',
            damage: '',
            text: ''
        };
        
        if (!attackString) return result;
        
        // Check if it's the simple format first: "Attack Name"
        if (!attackString.includes('[') && !attackString.includes('(')) {
            result.name = attackString.trim();
            return result;
        }
        
        // Try to match: [COST] NAME (DAMAGE) TEXT
        // Example: "[LLC] Voltage Burst (130+) This attack does..."
        const fullMatch = attackString.match(/^\[([^\]]*)\]\s*([^(]+?)(?:\s*\(([^)]*)\))?(?:\s*(.*))?$/);
        
        if (fullMatch) {
            result.cost = fullMatch[1] || '';
            result.name = (fullMatch[2] || '').trim();
            result.damage = fullMatch[3] || '';
            result.text = (fullMatch[4] || '').trim();
            return result;
        }
        
        // Try without cost: NAME (DAMAGE) TEXT
        // Example: "Slash (50) This attack does..."
        const noCostMatch = attackString.match(/^([^(]+?)(?:\s*\(([^)]*)\))?(?:\s*(.*))?$/);
        
        if (noCostMatch) {
            result.name = (noCostMatch[1] || '').trim();
            result.damage = noCostMatch[2] || '';
            result.text = (noCostMatch[3] || '').trim();
            return result;
        }
        
        // Fallback: treat the whole string as the attack name
        result.name = attackString.trim();
        return result;
    }
    
    parseCombinedAttacks(attacksText) {
        // Parse multiple attacks from a single text field
        // They might be separated by <br>, newlines, or other delimiters
        const attacks = [];
        
        if (!attacksText) return attacks;
        
        // Split by <br> tags or newlines
        const lines = attacksText.split(/<br\s*\/?>|\n/).filter(line => line.trim());
        
        lines.forEach(line => {
            const attack = this.parseAttack(line);
            if (attack.name) {
                attacks.push(attack);
            }
        });
        
        return attacks;
    }
    
    async downloadCardImages(cards, game, progressCallback) {
        const totalCards = cards.length;
        const downloadBatch = 10; // Download 10 images at a time
        let downloaded = 0;
        let failed = 0;
        
        console.log(`Starting image download for ${totalCards} cards...`);
        
        for (let i = 0; i < cards.length; i += downloadBatch) {
            const batch = cards.slice(i, i + downloadBatch);
            const promises = batch.map(async (card) => {
                if (card.image_url) {
                    try {
                        const localPath = await this.downloadImage(card.image_url, card.id, game);
                        if (localPath && localPath !== card.image_url) {
                            // Keep original URL in image_url (for re-downloading if needed)
                            // Store the local web-accessible path in local_image
                            card.local_image = `/cache/images/${game}/${path.basename(localPath)}`;
                        }
                    } catch (err) {
                        console.error(`Failed to download image for ${card.name}:`, err.message);
                        failed++;
                    }
                }
            });
            
            await Promise.all(promises);
            downloaded += batch.length;
            
            const percent = 80 + (downloaded / totalCards) * 10;
            progressCallback({
                status: 'downloading',
                percent: Math.floor(percent),
                message: `Downloading images... (${downloaded}/${totalCards}, ${failed} failed)`
            });
        }
        
        console.log(`Downloaded images: ${downloaded - failed} successful, ${failed} failed`);
    }
    
    async downloadImage(imageUrl, cardId, game) {
        if (!imageUrl || imageUrl.includes('placeholder')) {
            return imageUrl;
        }
        
        try {
            const safeId = cardId.replace(/[^a-z0-9_-]/gi, '_');
            const extension = '.jpg';
            const imagePath = path.join(this.imagesDir, game, `${safeId}${extension}`);
            
            // Check if already cached
            if (fs.existsSync(imagePath)) {
                console.log(`Image already cached: ${safeId}`);
                return imagePath;
            }
            
            // Smart retry logic - don't retry on 403/404 errors
            let retries = 5;
            let lastError;
            let attempt = 0;
            
            while (retries > 0) {
                attempt++;
                console.log(`Downloading image for ${safeId}, attempt ${attempt}`);
                
                try {
                    const response = await axios.get(imageUrl, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        headers: {
                            'User-Agent': 'CardCast/1.0.0'
                        }
                    });
                    
                    fs.writeFileSync(imagePath, response.data);
                    console.log(`Successfully downloaded: ${safeId}`);
                    return imagePath;
                    
                } catch (error) {
                    lastError = error;
                    
                    // Check if it's a 403 or 404 error - these won't be fixed by retrying
                    if (error.response && (error.response.status === 403 || error.response.status === 404)) {
                        console.log(`FAILED PERMANENTLY: ${safeId} - ${error.response.status === 403 ? 'Access forbidden (not available yet)' : 'Not found'}`);
                        console.error(`Error downloading image for ${safeId}: Request failed with status code ${error.response.status}`);
                        
                        // Don't retry for 403/404 errors - break immediately
                        break;
                    }
                    
                    // For other errors (network issues, timeouts), retry with backoff
                    retries--;
                    console.log(`Failed to download ${safeId}: ${error.message}, ${retries} retries left`);
                    
                    if (retries > 0) {
                        // Exponential backoff for network errors
                        const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                        await this.delay(waitTime);
                    }
                }
            }
            
            // If we got here and it wasn't a 403/404, it was a network issue
            if (!lastError.response || (lastError.response.status !== 403 && lastError.response.status !== 404)) {
                console.error(`Error downloading image for ${safeId} after ${attempt} attempts:`, lastError.message);
            }
            
            return imageUrl; // Return original URL if download fails
            
        } catch (error) {
            console.error(`Error downloading image for ${cardId}:`, error.message);
            return imageUrl;
        }
    }
}

module.exports = TCGCSVApi;