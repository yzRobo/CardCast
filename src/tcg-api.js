// src/tcg-api.js - CardCast TCGCSV.com Data Fetcher
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

class TCGApi {
    constructor(database) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        this.cacheDir = path.join(__dirname, '..', 'cache');
        
        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        
        // Game configurations for TCGCSV.com
        // Note: These URLs need to be verified with actual TCGCSV.com API
        this.gameConfigs = {
            pokemon: {
                name: 'Pokemon',
                csvUrl: 'https://tcgcsv.com/api/pokemon/cards',
                searchUrl: 'https://api.pokemontcg.io/v2/cards',
                apiKey: null, // Add if needed
                parseCard: this.parsePokemonCard.bind(this)
            },
            magic: {
                name: 'Magic: The Gathering',
                csvUrl: 'https://tcgcsv.com/api/magic/cards',
                searchUrl: 'https://api.scryfall.com/cards/search',
                parseCard: this.parseMagicCard.bind(this)
            },
            yugioh: {
                name: 'Yu-Gi-Oh!',
                csvUrl: 'https://tcgcsv.com/api/yugioh/cards',
                searchUrl: 'https://db.ygoprodeck.com/api/v7/cardinfo.php',
                parseCard: this.parseYugiohCard.bind(this)
            },
            lorcana: {
                name: 'Disney Lorcana',
                csvUrl: 'https://tcgcsv.com/api/lorcana/cards',
                searchUrl: null,
                parseCard: this.parseLorcanaCard.bind(this)
            },
            onepiece: {
                name: 'One Piece Card Game',
                csvUrl: 'https://tcgcsv.com/api/onepiece/cards',
                searchUrl: null,
                parseCard: this.parseOnePieceCard.bind(this)
            }
        };
    }
    
    async downloadGameData(game, progressCallback) {
        const config = this.gameConfigs[game];
        if (!config) {
            throw new Error(`Unsupported game: ${game}`);
        }
        
        console.log(`Starting download for ${config.name}...`);
        progressCallback({ status: 'starting', percent: 0, message: 'Preparing download...' });
        
        try {
            // Clear existing data
            this.db.clearGameData(game);
            
            progressCallback({ status: 'fetching', percent: 10, message: 'Fetching card data...' });
            
            // Fetch cards based on game
            let cards = [];
            
            switch(game) {
                case 'pokemon':
                    cards = await this.fetchPokemonCards(progressCallback);
                    break;
                case 'magic':
                    cards = await this.fetchMagicCards(progressCallback);
                    break;
                case 'yugioh':
                    cards = await this.fetchYugiohCards(progressCallback);
                    break;
                default:
                    // For games without public APIs, try TCGCSV or use sample data
                    cards = await this.fetchFromTCGCSV(game, config, progressCallback);
            }
            
            // Save to database
            progressCallback({ status: 'saving', percent: 90, message: 'Saving to database...' });
            
            if (cards.length > 0) {
                const batchSize = 100;
                for (let i = 0; i < cards.length; i += batchSize) {
                    const batch = cards.slice(i, i + batchSize);
                    this.db.bulkInsertCards(batch);
                    
                    const savePercent = 90 + (i / cards.length) * 10;
                    progressCallback({ 
                        status: 'saving', 
                        percent: Math.floor(savePercent), 
                        message: `Saving cards... (${i}/${cards.length})`
                    });
                }
            }
            
            this.db.updateGameInfo(game, cards.length);
            
            progressCallback({ status: 'complete', percent: 100, message: 'Download complete!' });
            console.log(`Downloaded ${cards.length} cards for ${config.name}`);
            
            return cards.length;
        } catch (error) {
            console.error(`Error downloading ${game} data:`, error);
            throw error;
        }
    }
    
    async fetchPokemonCards(progressCallback) {
        const cards = [];
        const pageSize = 250;
        let page = 1;
        let totalPages = 1;
        
        try {
            // Use Pokemon TCG API
            while (page <= totalPages && page <= 20) { // Limit to 20 pages for initial download
                progressCallback({ 
                    status: 'downloading', 
                    percent: 10 + (page / 20) * 70, 
                    message: `Fetching Pokemon cards... (Page ${page})`
                });
                
                const response = await axios.get('https://api.pokemontcg.io/v2/cards', {
                    params: {
                        page: page,
                        pageSize: pageSize
                    },
                    timeout: 30000
                });
                
                if (response.data && response.data.data) {
                    response.data.data.forEach(card => {
                        cards.push({
                            id: `pokemon_${card.id}`,
                            game: 'pokemon',
                            name: card.name,
                            set_name: card.set?.name || '',
                            set_code: card.set?.id || '',
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
                                abilities: card.abilities || [],
                                weaknesses: card.weaknesses || [],
                                resistances: card.resistances || []
                            }
                        });
                    });
                    
                    // Get total pages from first response
                    if (page === 1 && response.data.totalCount) {
                        totalPages = Math.ceil(response.data.totalCount / pageSize);
                    }
                }
                
                page++;
                await this.delay(100); // Rate limiting
            }
        } catch (error) {
            console.error('Error fetching Pokemon cards:', error.message);
            // Fall back to sample data if API fails
            return this.generateSampleCards('pokemon');
        }
        
        return cards;
    }
    
    async fetchMagicCards(progressCallback) {
        const cards = [];
        
        try {
            // Fetch popular/recent sets from Scryfall
            const sets = ['neo', 'snc', 'dmu', 'bro', 'one']; // Recent set codes
            
            for (let i = 0; i < sets.length; i++) {
                progressCallback({ 
                    status: 'downloading', 
                    percent: 10 + (i / sets.length) * 70, 
                    message: `Fetching Magic cards... (Set ${i + 1}/${sets.length})`
                });
                
                const response = await axios.get('https://api.scryfall.com/cards/search', {
                    params: {
                        q: `set:${sets[i]}`,
                        format: 'json'
                    },
                    timeout: 30000
                });
                
                if (response.data && response.data.data) {
                    response.data.data.forEach(card => {
                        cards.push({
                            id: `magic_${card.id}`,
                            game: 'magic',
                            name: card.name,
                            set_name: card.set_name || '',
                            set_code: card.set || '',
                            card_number: card.collector_number || '',
                            image_url: card.image_uris?.normal || card.image_uris?.small || '',
                            rarity: card.rarity || 'common',
                            card_type: card.type_line || '',
                            card_text: card.oracle_text || '',
                            attributes: {
                                manaCost: card.mana_cost || '',
                                cmc: card.cmc || 0,
                                power: card.power || null,
                                toughness: card.toughness || null,
                                colors: card.colors || [],
                                colorIdentity: card.color_identity || []
                            }
                        });
                    });
                }
                
                await this.delay(100); // Rate limiting
            }
        } catch (error) {
            console.error('Error fetching Magic cards:', error.message);
            return this.generateSampleCards('magic');
        }
        
        return cards;
    }
    
    async fetchYugiohCards(progressCallback) {
        const cards = [];
        
        try {
            progressCallback({ 
                status: 'downloading', 
                percent: 40, 
                message: 'Fetching Yu-Gi-Oh! cards...'
            });
            
            // Fetch staple cards
            const response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                params: {
                    staple: 'yes',
                    num: 100,
                    offset: 0
                },
                timeout: 30000
            });
            
            if (response.data && response.data.data) {
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
            return this.generateSampleCards('yugioh');
        }
        
        return cards;
    }
    
    async fetchFromTCGCSV(game, config, progressCallback) {
        // Try to fetch from TCGCSV.com
        // This would need the actual API endpoints from TCGCSV
        try {
            progressCallback({ 
                status: 'downloading', 
                percent: 40, 
                message: `Fetching ${config.name} cards from TCGCSV...`
            });
            
            // For now, return sample data
            // Replace this with actual TCGCSV API call when endpoints are known
            console.log(`TCGCSV integration pending for ${game}`);
            return this.generateSampleCards(game);
            
        } catch (error) {
            console.error(`Error fetching from TCGCSV for ${game}:`, error);
            return this.generateSampleCards(game);
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
    
    // Parse methods for each game
    parsePokemonCard(data) {
        return {
            id: `pokemon_${data.id}`,
            game: 'pokemon',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set_code,
            card_number: data.card_number,
            image_url: data.image_url,
            rarity: data.rarity,
            card_type: data.card_type,
            card_text: data.card_text,
            attributes: data.attributes
        };
    }
    
    parseMagicCard(data) {
        return {
            id: `magic_${data.id}`,
            game: 'magic',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set_code,
            card_number: data.card_number,
            image_url: data.image_url,
            rarity: data.rarity,
            card_type: data.card_type,
            card_text: data.card_text,
            attributes: data.attributes
        };
    }
    
    parseYugiohCard(data) {
        return {
            id: `yugioh_${data.id}`,
            game: 'yugioh',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set_code,
            card_number: data.card_number,
            image_url: data.image_url,
            rarity: data.rarity,
            card_type: data.card_type,
            card_text: data.card_text,
            attributes: data.attributes
        };
    }
    
    parseLorcanaCard(data) {
        return {
            id: `lorcana_${data.id}`,
            game: 'lorcana',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set_code,
            card_number: data.card_number,
            image_url: data.image_url,
            rarity: data.rarity,
            card_type: data.card_type,
            card_text: data.card_text,
            attributes: data.attributes
        };
    }
    
    parseOnePieceCard(data) {
        return {
            id: `onepiece_${data.id}`,
            game: 'onepiece',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set_code,
            card_number: data.card_number,
            image_url: data.image_url,
            rarity: data.rarity,
            card_type: data.card_type,
            card_text: data.card_text,
            attributes: data.attributes
        };
    }
    
    // Keep sample data generator as fallback
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
            },
            lorcana: {
                inkCost: Math.floor(Math.random() * 7) + 1,
                strength: Math.floor(Math.random() * 10),
                willpower: Math.floor(Math.random() * 10)
            },
            onepiece: {
                cost: Math.floor(Math.random() * 10),
                power: Math.floor(Math.random() * 10000),
                counter: Math.floor(Math.random() * 2000)
            }
        };
        
        return attributes[game] || {};
    }
    
    async downloadImage(imageUrl, cardId) {
        if (!imageUrl || imageUrl.includes('placeholder')) {
            return imageUrl;
        }
        
        try {
            const extension = path.extname(imageUrl) || '.jpg';
            const imagePath = path.join(this.cacheDir, `${cardId}${extension}`);
            
            // Check if already cached
            if (fs.existsSync(imagePath)) {
                return imagePath;
            }
            
            // Download image
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 30000
            });
            
            fs.writeFileSync(imagePath, response.data);
            return imagePath;
        } catch (error) {
            console.error(`Error downloading image for ${cardId}:`, error.message);
            return imageUrl; // Return original URL if download fails
        }
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TCGApi;