// src/tcgcsv-api.js - TCGCSV.com Real API Integration
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser'); // Need to add this dependency
const stream = require('stream');
const { promisify } = require('util');

class TCGCSVApi {
    constructor(database) {
        this.db = database;
        this.baseUrl = 'https://tcgcsv.com';
        this.cacheDir = path.join(__dirname, '..', 'cache');
        
        // Ensure cache directory exists
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        
        // TCGCSV Category IDs from your list
        this.categories = {
            pokemon: { id: 3, name: 'Pokemon' },
            magic: { id: 1, name: 'Magic' },
            yugioh: { id: 2, name: 'YuGiOh' },
            lorcana: { id: 71, name: 'Lorcana TCG' },
            onepiece: { id: 68, name: 'One Piece Card Game' },
            digimon: { id: 63, name: 'Digimon Card Game' },
            fab: { id: 62, name: 'Flesh & Blood TCG' },
            starwars: { id: 79, name: 'Star Wars Unlimited' },
            dragonball: { id: 80, name: 'Dragon Ball Super Fusion World' },
            vanguard: { id: 16, name: 'Cardfight Vanguard' },
            weiss: { id: 20, name: 'Weiss Schwarz' },
            shadowverse: { id: 73, name: 'Shadowverse Evolve' },
            metazoo: { id: 66, name: 'MetaZoo' },
            grandarchive: { id: 74, name: 'Grand Archive' },
            sorcery: { id: 77, name: 'Sorcery Contested Realm' },
            universus: { id: 25, name: 'UniVersus' },
            keyforge: { id: 59, name: 'KeyForge' },
            force: { id: 17, name: 'Force of Will' }
        };
    }
    
    async downloadGameData(game, progressCallback) {
        const category = this.categories[game];
        if (!category) {
            throw new Error(`Unsupported game: ${game}`);
        }
        
        console.log(`Starting download for ${category.name} (ID: ${category.id})...`);
        progressCallback({ status: 'starting', percent: 0, message: 'Preparing download...' });
        
        try {
            // Clear existing data
            this.db.clearGameData(game);
            
            progressCallback({ status: 'fetching', percent: 10, message: 'Fetching card list from TCGCSV...' });
            
            // Download the CSV file
            const csvData = await this.downloadCSV(category.id, progressCallback);
            
            progressCallback({ status: 'parsing', percent: 50, message: 'Parsing card data...' });
            
            // Parse CSV data
            const cards = await this.parseCSVData(csvData, game, category, progressCallback);
            
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
            console.log(`Downloaded ${cards.length} cards for ${category.name}`);
            
            return cards.length;
        } catch (error) {
            console.error(`Error downloading ${game} data:`, error);
            
            // Handle fallback to direct APIs for major games
            if (error.message?.includes('TCGCSV_FALLBACK')) {
                console.log(`Attempting fallback API for ${game}...`);
                const DirectAPI = require('./tcg-api');
                const directApi = new DirectAPI(this.db);
                return await directApi.downloadGameData(game, progressCallback);
            }
            
            throw error;
        }
    }
    
    async downloadCSV(categoryId, progressCallback) {
        try {
            // TCGCSV download URL pattern (this needs to be verified with actual site)
            // Common patterns are:
            // - https://tcgcsv.com/download/{categoryId}/groups.csv
            // - https://tcgcsv.com/api/download?category={categoryId}
            // - https://tcgcsv.com/files/{categoryId}/Groups.csv
            
            const urls = [
                `${this.baseUrl}/download/${categoryId}/Groups.csv`,
                `${this.baseUrl}/files/${categoryId}/Groups.csv`,
                `${this.baseUrl}/api/download?category=${categoryId}`,
                `${this.baseUrl}/downloads/category${categoryId}.csv`
            ];
            
            let csvData = null;
            let lastError = null;
            
            // Try each URL pattern
            for (const url of urls) {
                try {
                    console.log(`Trying URL: ${url}`);
                    progressCallback({ 
                        status: 'downloading', 
                        percent: 20, 
                        message: `Downloading from TCGCSV...`
                    });
                    
                    const response = await axios.get(url, {
                        responseType: 'text',
                        timeout: 120000, // 2 minute timeout for CSV downloads
                        headers: {
                            'User-Agent': 'CardCast/1.0.0 (TCG Streaming Tool)',
                            'Accept': 'text/csv,application/csv,text/plain,*/*',
                            'Accept-Encoding': 'gzip, deflate',
                            'Connection': 'keep-alive'
                        },
                        maxRedirects: 5,
                        onDownloadProgress: (progressEvent) => {
                            if (progressEvent.total) {
                                const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                                progressCallback({ 
                                    status: 'downloading', 
                                    percent: 20 + (percentCompleted * 0.3), 
                                    message: `Downloading... ${percentCompleted}%`
                                });
                            }
                        }
                    });
                    
                    if (response.data) {
                        csvData = response.data;
                        console.log(`Successfully downloaded from: ${url}`);
                        break;
                    }
                } catch (error) {
                    lastError = error;
                    console.log(`Failed to download from ${url}: ${error.message}`);
                }
            }
            
            if (!csvData) {
                // For popular games, fall back to their direct APIs
                if (categoryId === 3) { // Pokemon
                    console.log('TCGCSV failed for Pokemon, falling back to Pokemon TCG API...');
                    throw new Error('TCGCSV_FALLBACK_POKEMON');
                } else if (categoryId === 1) { // Magic
                    console.log('TCGCSV failed for Magic, falling back to Scryfall API...');
                    throw new Error('TCGCSV_FALLBACK_MAGIC');
                } else if (categoryId === 2) { // YuGiOh
                    console.log('TCGCSV failed for YuGiOh, falling back to YGOPRODeck API...');
                    throw new Error('TCGCSV_FALLBACK_YUGIOH');
                }
                throw new Error(`Failed to download CSV data for category ${categoryId}. Last error: ${lastError?.message}`);
            }
            
            return csvData;
        } catch (error) {
            console.error('CSV download error:', error);
            throw error;
        }
    }
    
    async parseCSVData(csvData, game, category, progressCallback) {
        return new Promise((resolve, reject) => {
            const cards = [];
            const results = [];
            
            // Convert string to stream for csv-parser
            const readable = stream.Readable.from(csvData);
            
            readable
                .pipe(csv())
                .on('data', (row) => {
                    results.push(row);
                })
                .on('end', () => {
                    console.log(`Parsed ${results.length} rows from CSV`);
                    
                    // Process each row based on game type
                    results.forEach((row, index) => {
                        const card = this.parseCardRow(row, game, category);
                        if (card) {
                            cards.push(card);
                        }
                        
                        if (index % 100 === 0) {
                            const percent = 50 + (index / results.length) * 40;
                            progressCallback({ 
                                status: 'parsing', 
                                percent: Math.floor(percent), 
                                message: `Processing cards... (${index}/${results.length})`
                            });
                        }
                    });
                    
                    resolve(cards);
                })
                .on('error', reject);
        });
    }
    
    parseCardRow(row, game, category) {
        // TCGCSV CSV format typically has these columns:
        // ProductId, ProductName, CategoryId, GroupId, ProductUrl, ImageUrl, SetName, Number, Rarity, Condition, Price, etc.
        
        try {
            // Common fields mapping
            const card = {
                id: `${game}_${row.ProductId || row.Id || Math.random().toString(36).substr(2, 9)}`,
                game: game,
                name: row.ProductName || row.Name || row.CardName || 'Unknown Card',
                set_name: row.SetName || row.GroupName || row.Set || '',
                set_code: row.SetCode || row.GroupId || '',
                card_number: row.Number || row.CardNumber || row.CollectorNumber || '',
                image_url: this.parseImageUrl(row),
                rarity: row.Rarity || row.CardRarity || 'Common',
                card_type: row.Type || row.CardType || '',
                card_text: row.Text || row.CardText || row.OracleText || '',
                attributes: this.parseAttributes(row, game)
            };
            
            // Skip if no name
            if (!card.name || card.name === 'Unknown Card') {
                return null;
            }
            
            return card;
        } catch (error) {
            console.error('Error parsing card row:', error);
            return null;
        }
    }
    
    parseImageUrl(row) {
        // Try different possible image URL fields
        const imageUrl = row.ImageUrl || row.Image || row.CardImage || row.PictureUrl || '';
        
        // If it's a relative URL, make it absolute
        if (imageUrl && !imageUrl.startsWith('http')) {
            return `${this.baseUrl}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
        }
        
        return imageUrl;
    }
    
    parseAttributes(row, game) {
        const attributes = {};
        
        // Game-specific attribute parsing
        switch(game) {
            case 'pokemon':
                attributes.hp = row.HP || row.HealthPoints || null;
                attributes.type = row.Type || row.PokemonType || '';
                attributes.weakness = row.Weakness || '';
                attributes.resistance = row.Resistance || '';
                attributes.retreatCost = row.RetreatCost || '';
                break;
                
            case 'magic':
                attributes.manaCost = row.ManaCost || row.Cost || '';
                attributes.power = row.Power || row.Pow || null;
                attributes.toughness = row.Toughness || row.Tou || null;
                attributes.cmc = row.CMC || row.ConvertedManaCost || 0;
                break;
                
            case 'yugioh':
                attributes.attack = row.ATK || row.Attack || null;
                attributes.defense = row.DEF || row.Defense || null;
                attributes.level = row.Level || row.Rank || null;
                attributes.attribute = row.Attribute || '';
                break;
                
            case 'lorcana':
                attributes.inkCost = row.InkCost || row.Cost || null;
                attributes.strength = row.Strength || row.Power || null;
                attributes.willpower = row.Willpower || row.Defense || null;
                attributes.lore = row.Lore || null;
                break;
                
            case 'onepiece':
                attributes.cost = row.Cost || null;
                attributes.power = row.Power || null;
                attributes.counter = row.Counter || null;
                attributes.life = row.Life || null;
                break;
                
            default:
                // Generic attributes
                attributes.cost = row.Cost || row.ManaCost || null;
                attributes.power = row.Power || row.Attack || null;
                attributes.defense = row.Defense || row.Toughness || null;
        }
        
        // Add price info if available
        attributes.marketPrice = row.MarketPrice || row.Price || null;
        attributes.lowPrice = row.LowPrice || null;
        attributes.highPrice = row.HighPrice || null;
        
        return attributes;
    }
    
    async downloadCardImage(imageUrl, cardId) {
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
                timeout: 30000,
                headers: {
                    'User-Agent': 'CardCast/1.0.0'
                }
            });
            
            fs.writeFileSync(imagePath, response.data);
            return imagePath;
        } catch (error) {
            console.error(`Error downloading image for ${cardId}:`, error.message);
            return imageUrl; // Return original URL if download fails
        }
    }
}

module.exports = TCGCSVApi;