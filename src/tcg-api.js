// src/tcg-api.js - CardCast TCGCSV.com Data Fetcher
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

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
        this.gameConfigs = {
            pokemon: {
                name: 'Pokemon',
                csvUrl: 'https://tcgcsv.com/api/export/pokemon/all',
                imageBaseUrl: 'https://images.pokemontcg.io/',
                parseCard: this.parsePokemonCard.bind(this)
            },
            magic: {
                name: 'Magic: The Gathering',
                csvUrl: 'https://tcgcsv.com/api/export/magic/all',
                imageBaseUrl: 'https://gatherer.wizards.com/Handlers/Image.ashx',
                parseCard: this.parseMagicCard.bind(this)
            },
            yugioh: {
                name: 'Yu-Gi-Oh!',
                csvUrl: 'https://tcgcsv.com/api/export/yugioh/all',
                imageBaseUrl: 'https://images.ygoprodeck.com/images/cards/',
                parseCard: this.parseYugiohCard.bind(this)
            },
            lorcana: {
                name: 'Disney Lorcana',
                csvUrl: 'https://tcgcsv.com/api/export/lorcana/all',
                imageBaseUrl: null,
                parseCard: this.parseLorcanaCard.bind(this)
            },
            onepiece: {
                name: 'One Piece Card Game',
                csvUrl: 'https://tcgcsv.com/api/export/onepiece/all',
                imageBaseUrl: null,
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
            
            // For now, we'll use sample data to get the system working
            // In production, this would fetch from TCGCSV.com
            progressCallback({ status: 'fetching', percent: 10, message: 'Fetching card data...' });
            
            const cards = await this.fetchGameCards(game, config, progressCallback);
            
            // Save to database
            progressCallback({ status: 'saving', percent: 90, message: 'Saving to database...' });
            
            if (cards.length > 0) {
                // Insert in batches for performance
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
    
    async fetchGameCards(game, config, progressCallback) {
        // Create sample data to test the system
        // Replace this with actual TCGCSV.com API calls
        const sampleCards = this.generateSampleCards(game);
        
        // Simulate download progress
        for (let i = 20; i <= 80; i += 10) {
            progressCallback({ 
                status: 'downloading', 
                percent: i, 
                message: `Downloading cards... (${i}%)`
            });
            await this.delay(200);
        }
        
        return sampleCards;
    }
    
    generateSampleCards(game) {
        const cards = [];
        const sets = this.getSampleSets(game);
        
        sets.forEach((set, setIndex) => {
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
                { name: 'Paldea Evolved', code: 'pal', totalCards: 279 },
                { name: 'Obsidian Flames', code: 'obf', totalCards: 230 }
            ],
            magic: [
                { name: 'The Lost Caverns of Ixalan', code: 'lci', totalCards: 400 },
                { name: 'Wilds of Eldraine', code: 'woe', totalCards: 375 },
                { name: 'March of the Machine', code: 'mom', totalCards: 450 }
            ],
            yugioh: [
                { name: 'Phantom Nightmare', code: 'phnm', totalCards: 100 },
                { name: 'Age of Overlord', code: 'agov', totalCards: 100 },
                { name: 'Duelist Nexus', code: 'dune', totalCards: 100 }
            ],
            lorcana: [
                { name: 'The First Chapter', code: 'tfc', totalCards: 204 },
                { name: 'Rise of the Floodborn', code: 'rof', totalCards: 204 },
                { name: 'Into the Inklands', code: 'ink', totalCards: 204 }
            ],
            onepiece: [
                { name: 'Romance Dawn', code: 'op01', totalCards: 121 },
                { name: 'Paramount War', code: 'op02', totalCards: 121 },
                { name: 'Pillars of Strength', code: 'op03', totalCards: 117 }
            ]
        };
        
        return sets[game] || [];
    }
    
    getSampleImageUrl(game, setCode, cardNumber) {
        // Return placeholder image URLs
        // In production, these would be actual card image URLs
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
            magic: ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land', 'Planeswalker'],
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
                type: ['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Fighting'][Math.floor(Math.random() * 6)],
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
    
    // Parse methods for each game (to be used with real data)
    parsePokemonCard(row) {
        return {
            name: row.name || '',
            hp: row.hp || null,
            type: row.type || '',
            rarity: row.rarity || '',
            retreatCost: row.retreat_cost || 0
        };
    }
    
    parseMagicCard(row) {
        return {
            name: row.name || '',
            manaCost: row.mana_cost || '',
            cmc: row.cmc || 0,
            power: row.power || null,
            toughness: row.toughness || null
        };
    }
    
    parseYugiohCard(row) {
        return {
            name: row.name || '',
            attack: row.atk || null,
            defense: row.def || null,
            level: row.level || null,
            attribute: row.attribute || ''
        };
    }
    
    parseLorcanaCard(row) {
        return {
            name: row.name || '',
            inkCost: row.ink_cost || null,
            strength: row.strength || null,
            willpower: row.willpower || null
        };
    }
    
    parseOnePieceCard(row) {
        return {
            name: row.name || '',
            cost: row.cost || null,
            power: row.power || null,
            counter: row.counter || null
        };
    }
    
    async downloadImage(imageUrl, cardId) {
        if (!imageUrl || imageUrl.includes('placeholder')) {
            return imageUrl; // Return placeholder URLs as-is for testing
        }
        
        try {
            const extension = '.jpg';
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
            return null;
        }
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TCGApi;