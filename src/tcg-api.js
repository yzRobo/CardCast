// src/tcg-api.js - CardCast TCG Data Fetcher
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

class TCGApi {
    constructor(database) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        this.cacheDir = path.join(__dirname, '..', 'cache');
        
        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        
        // Game-specific configurations
        this.gameConfigs = {
            pokemon: {
                categoryId: 3,
                name: 'Pokemon',
                apiUrl: 'https://api.pokemontcg.io/v2/cards',
                parseCard: this.parsePokemonCard.bind(this)
            },
            magic: {
                categoryId: 1,
                name: 'Magic: The Gathering',
                apiUrl: 'https://api.scryfall.com/cards/search',
                parseCard: this.parseMagicCard.bind(this)
            },
            yugioh: {
                categoryId: 2,
                name: 'Yu-Gi-Oh!',
                apiUrl: 'https://db.ygoprodeck.com/api/v7/cardinfo.php',
                parseCard: this.parseYugiohCard.bind(this)
            },
            lorcana: {
                categoryId: 71,
                name: 'Disney Lorcana',
                apiUrl: null, // Will use TCGCSV
                parseCard: this.parseLorcanaCard.bind(this)
            },
            onepiece: {
                categoryId: 70,
                name: 'One Piece Card Game',
                apiUrl: null, // Will use TCGCSV
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
        progressCallback({ status: 'starting', percent: 0 });
        
        try {
            let cards = [];
            
            // Use specific API if available, otherwise fallback to TCGCSV
            if (game === 'pokemon') {
                cards = await this.fetchPokemonCards(progressCallback);
            } else if (game === 'magic') {
                cards = await this.fetchMagicCards(progressCallback);
            } else if (game === 'yugioh') {
                cards = await this.fetchYugiohCards(progressCallback);
            } else {
                cards = await this.fetchTCGCSVCards(game, config.categoryId, progressCallback);
            }
            
            // Save to database
            progressCallback({ status: 'saving', percent: 90 });
            this.db.clearGameData(game);
            this.db.bulkInsertCards(cards);
            this.db.updateGameInfo(game, cards.length);
            
            progressCallback({ status: 'complete', percent: 100 });
            console.log(`Downloaded ${cards.length} cards for ${config.name}`);
            
            return cards.length;
        } catch (error) {
            console.error(`Error downloading ${game} data:`, error);
            throw error;
        }
    }
    
    async fetchPokemonCards(progressCallback) {
        const cards = [];
        let page = 1;
        let totalPages = 1;
        
        while (page <= totalPages) {
            progressCallback({ 
                status: 'downloading', 
                percent: Math.floor((page / totalPages) * 80),
                message: `Fetching page ${page}/${totalPages}`
            });
            
            try {
                const response = await axios.get('https://api.pokemontcg.io/v2/cards', {
                    params: { page, pageSize: 250 }
                });
                
                if (page === 1) {
                    totalPages = Math.ceil(response.data.totalCount / 250);
                }
                
                for (const card of response.data.data) {
                    cards.push(this.parsePokemonCard(card));
                }
                
                page++;
                
                // Rate limiting
                await this.delay(100);
            } catch (error) {
                console.error(`Error fetching Pokemon page ${page}:`, error.message);
                break;
            }
        }
        
        return cards;
    }
    
    parsePokemonCard(data) {
        return {
            id: data.id,
            game: 'pokemon',
            name: data.name,
            set_name: data.set.name,
            set_code: data.set.id,
            card_number: data.number,
            image_url: data.images.large || data.images.small,
            rarity: data.rarity,
            card_type: data.supertype,
            card_text: this.getPokemonCardText(data),
            attributes: {
                hp: data.hp,
                types: data.types,
                weakness: data.weaknesses,
                resistance: data.resistances,
                retreat: data.retreatCost,
                attacks: data.attacks,
                abilities: data.abilities,
                rules: data.rules
            }
        };
    }
    
    getPokemonCardText(card) {
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
    
    async fetchMagicCards(progressCallback) {
        const cards = [];
        let hasMore = true;
        let page = 1;
        
        // For demo, just fetch standard legal cards to keep it manageable
        let query = 'f:standard';
        
        while (hasMore && cards.length < 5000) { // Limit for demo
            progressCallback({ 
                status: 'downloading', 
                percent: Math.min(Math.floor((cards.length / 5000) * 80), 79),
                message: `Fetched ${cards.length} cards...`
            });
            
            try {
                const response = await axios.get('https://api.scryfall.com/cards/search', {
                    params: { q: query, page }
                });
                
                for (const card of response.data.data) {
                    // Skip tokens and art cards
                    if (!card.type_line.includes('Token') && card.layout !== 'art_series') {
                        cards.push(this.parseMagicCard(card));
                    }
                }
                
                hasMore = response.data.has_more;
                page++;
                
                // Scryfall rate limit: 10 requests per second
                await this.delay(150);
            } catch (error) {
                console.error(`Error fetching Magic cards:`, error.message);
                hasMore = false;
            }
        }
        
        return cards;
    }
    
    parseMagicCard(data) {
        return {
            id: data.id,
            game: 'magic',
            name: data.name,
            set_name: data.set_name,
            set_code: data.set,
            card_number: data.collector_number,
            image_url: data.image_uris?.large || data.image_uris?.normal,
            rarity: data.rarity,
            card_type: data.type_line,
            card_text: data.oracle_text || '',
            attributes: {
                mana_cost: data.mana_cost,
                cmc: data.cmc,
                colors: data.colors,
                power: data.power,
                toughness: data.toughness,
                loyalty: data.loyalty,
                keywords: data.keywords
            }
        };
    }
    
    async fetchYugiohCards(progressCallback) {
        const cards = [];
        
        try {
            progressCallback({ 
                status: 'downloading', 
                percent: 10,
                message: 'Fetching Yu-Gi-Oh card database...'
            });
            
            // YGOProDeck provides all cards in one request
            const response = await axios.get('https://db.ygoprodeck.com/api/v7/cardinfo.php', {
                timeout: 60000 // 60 second timeout for large response
            });
            
            const totalCards = response.data.data.length;
            
            for (let i = 0; i < Math.min(totalCards, 10000); i++) { // Limit for demo
                const card = response.data.data[i];
                cards.push(this.parseYugiohCard(card));
                
                if (i % 100 === 0) {
                    progressCallback({ 
                        status: 'downloading', 
                        percent: Math.floor((i / Math.min(totalCards, 10000)) * 80),
                        message: `Processing ${i}/${Math.min(totalCards, 10000)} cards...`
                    });
                }
            }
        } catch (error) {
            console.error('Error fetching Yu-Gi-Oh cards:', error.message);
            throw error;
        }
        
        return cards;
    }
    
    parseYugiohCard(data) {
        return {
            id: String(data.id),
            game: 'yugioh',
            name: data.name,
            set_name: data.card_sets?.[0]?.set_name || 'Unknown Set',
            set_code: data.card_sets?.[0]?.set_code || '',
            card_number: data.card_sets?.[0]?.set_code || '',
            image_url: data.card_images[0].image_url,
            rarity: data.card_sets?.[0]?.set_rarity || '',
            card_type: data.type,
            card_text: data.desc || '',
            attributes: {
                atk: data.atk,
                def: data.def,
                level: data.level,
                race: data.race,
                attribute: data.attribute,
                link: data.linkval,
                scale: data.scale,
                archetype: data.archetype
            }
        };
    }
    
    async fetchTCGCSVCards(game, categoryId, progressCallback) {
        const cards = [];
        
        try {
            // For Lorcana and One Piece, we'll use TCGCSV data
            progressCallback({ 
                status: 'downloading', 
                percent: 10,
                message: `Fetching ${game} data from TCGCSV...`
            });
            
            // This is a simplified version - in production you'd want to
            // properly fetch from TCGCSV API endpoints
            const response = await axios.get(`${this.baseUrl}/${categoryId}/groups`);
            
            // Parse and process the data
            // Note: This is placeholder - actual implementation would
            // parse the TCGCSV format properly
            progressCallback({ 
                status: 'downloading', 
                percent: 50,
                message: 'Processing card data...'
            });
            
            // For now, return empty array - full implementation would
            // fetch and parse actual TCGCSV data
            return cards;
        } catch (error) {
            console.error(`Error fetching ${game} from TCGCSV:`, error.message);
            return cards;
        }
    }
    
    parseLorcanaCard(data) {
        return {
            id: data.productId,
            game: 'lorcana',
            name: data.name,
            set_name: data.groupName,
            set_code: data.groupId,
            card_number: data.number,
            image_url: data.imageUrl,
            rarity: data.rarity,
            card_type: data.type,
            card_text: data.text || '',
            attributes: {
                ink_cost: data.inkCost,
                strength: data.strength,
                willpower: data.willpower,
                lore: data.lore,
                classifications: data.classifications
            }
        };
    }
    
    parseOnePieceCard(data) {
        return {
            id: data.productId,
            game: 'onepiece',
            name: data.name,
            set_name: data.groupName,
            set_code: data.groupId,
            card_number: data.number,
            image_url: data.imageUrl,
            rarity: data.rarity,
            card_type: data.type,
            card_text: data.text || '',
            attributes: {
                cost: data.cost,
                power: data.power,
                counter: data.counter,
                color: data.color,
                traits: data.traits
            }
        };
    }
    
    async downloadImage(imageUrl, cardId) {
        try {
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer'
            });
            
            const imagePath = path.join(this.cacheDir, `${cardId}.jpg`);
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