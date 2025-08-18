// src/tcg-api.js - CardCast TCGCSV.com Data Fetcher
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
        
        // TCGCSV category IDs
        this.gameConfigs = {
            pokemon: {
                categoryId: 3,
                name: 'Pokemon',
                setListUrl: '/3/Pokemon/categories'
            },
            magic: {
                categoryId: 1,
                name: 'Magic: The Gathering',
                setListUrl: '/1/Magic%20the%20Gathering/categories'
            },
            yugioh: {
                categoryId: 2,
                name: 'Yu-Gi-Oh!',
                setListUrl: '/2/Yugioh/categories'
            },
            lorcana: {
                categoryId: 71,
                name: 'Disney Lorcana',
                setListUrl: '/71/Disney%20Lorcana/categories'
            },
            onepiece: {
                categoryId: 70,
                name: 'One Piece Card Game',
                setListUrl: '/70/One%20Piece%20Card%20Game/categories'
            },
            digimon: {
                categoryId: 60,
                name: 'Digimon Card Game',
                setListUrl: '/60/Digimon%20Card%20Game/categories'
            },
            fab: {
                categoryId: 61,
                name: 'Flesh and Blood',
                setListUrl: '/61/Flesh%20and%20Blood%20TCG/categories'
            },
            starwars: {
                categoryId: 82,
                name: 'Star Wars Unlimited',
                setListUrl: '/82/Star%20Wars%20Unlimited/categories'
            }
        };
    }
    
    async downloadGameData(game, progressCallback) {
        const config = this.gameConfigs[game];
        if (!config) {
            throw new Error(`Unsupported game: ${game}`);
        }
        
        console.log(`Starting download for ${config.name} from TCGCSV...`);
        progressCallback({ status: 'starting', percent: 0, message: 'Connecting to TCGCSV...' });
        
        try {
            // Step 1: Get all sets for this game
            progressCallback({ status: 'fetching', percent: 5, message: 'Fetching set list...' });
            const sets = await this.fetchSetList(config);
            
            if (!sets || sets.length === 0) {
                throw new Error(`No sets found for ${config.name}`);
            }
            
            console.log(`Found ${sets.length} sets for ${config.name}`);
            
            // Step 2: Fetch cards from each set
            const allCards = [];
            let setsProcessed = 0;
            
            for (const set of sets) {
                const setPercent = 10 + (setsProcessed / sets.length) * 80;
                progressCallback({ 
                    status: 'downloading', 
                    percent: Math.floor(setPercent),
                    message: `Fetching ${set.name} (${setsProcessed + 1}/${sets.length})...`
                });
                
                try {
                    const cards = await this.fetchSetCards(game, set);
                    allCards.push(...cards);
                    console.log(`Fetched ${cards.length} cards from ${set.name}`);
                } catch (error) {
                    console.error(`Error fetching set ${set.name}:`, error.message);
                    // Continue with other sets
                }
                
                setsProcessed++;
                
                // Rate limiting
                await this.delay(500);
            }
            
            // Step 3: Save to database
            progressCallback({ status: 'saving', percent: 90, message: 'Saving to database...' });
            
            this.db.clearGameData(game);
            
            // Insert in batches
            const batchSize = 100;
            for (let i = 0; i < allCards.length; i += batchSize) {
                const batch = allCards.slice(i, i + batchSize);
                this.db.bulkInsertCards(batch);
            }
            
            this.db.updateGameInfo(game, allCards.length);
            
            progressCallback({ status: 'complete', percent: 100, message: 'Download complete!' });
            console.log(`Downloaded ${allCards.length} cards for ${config.name}`);
            
            return allCards.length;
        } catch (error) {
            console.error(`Error downloading ${game} data:`, error);
            throw error;
        }
    }
    
    async fetchSetList(config) {
        try {
            const url = `${this.baseUrl}${config.setListUrl}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 30000
            });
            
            const $ = cheerio.load(response.data);
            const sets = [];
            
            // Parse the set list from TCGCSV's category page
            $('.category-item, .set-item, a[href*="/group/"]').each((i, elem) => {
                const $elem = $(elem);
                const href = $elem.attr('href');
                const name = $elem.text().trim();
                
                if (href && name) {
                    // Extract group ID from URL
                    const match = href.match(/\/group\/(\d+)/);
                    if (match) {
                        sets.push({
                            id: match[1],
                            name: name,
                            url: href
                        });
                    }
                }
            });
            
            // If no sets found with above selectors, try table rows
            if (sets.length === 0) {
                $('tr').each((i, elem) => {
                    const $elem = $(elem);
                    const link = $elem.find('a[href*="/group/"]');
                    if (link.length > 0) {
                        const href = link.attr('href');
                        const name = link.text().trim();
                        const match = href.match(/\/group\/(\d+)/);
                        if (match) {
                            sets.push({
                                id: match[1],
                                name: name,
                                url: href
                            });
                        }
                    }
                });
            }
            
            return sets;
        } catch (error) {
            console.error('Error fetching set list:', error);
            return [];
        }
    }
    
    async fetchSetCards(game, set) {
        const cards = [];
        
        try {
            // TCGCSV provides CSV downloads for each set
            const csvUrl = `${this.baseUrl}/group/${set.id}/export`;
            
            const response = await axios.get(csvUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 30000
            });
            
            // Parse CSV data
            const rows = this.parseCSV(response.data);
            
            for (const row of rows) {
                const card = this.parseCardFromCSV(game, row, set);
                if (card) {
                    cards.push(card);
                }
            }
        } catch (error) {
            // If CSV export fails, try scraping HTML page
            try {
                const htmlUrl = `${this.baseUrl}${set.url}`;
                const response = await axios.get(htmlUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 30000
                });
                
                const $ = cheerio.load(response.data);
                
                // Parse cards from HTML table
                $('tr.product-row, .card-row, tr[data-product-id]').each((i, elem) => {
                    const card = this.parseCardFromHTML($, $(elem), game, set);
                    if (card) {
                        cards.push(card);
                    }
                });
            } catch (htmlError) {
                console.error(`Failed to fetch cards from set ${set.name}:`, htmlError.message);
            }
        }
        
        return cards;
    }
    
    parseCSV(csvText) {
        const rows = [];
        const lines = csvText.split('\n');
        
        if (lines.length < 2) return rows;
        
        // Parse header
        const headers = this.parseCSVLine(lines[0]);
        
        // Parse data rows
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const values = this.parseCSVLine(line);
                const row = {};
                headers.forEach((header, index) => {
                    row[header] = values[index] || '';
                });
                rows.push(row);
            }
        }
        
        return rows;
    }
    
    parseCSVLine(line) {
        const values = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        
        values.push(current.trim());
        return values;
    }
    
    parseCardFromCSV(game, row, set) {
        try {
            // Map CSV columns to card object
            // Column names may vary by game, so we'll try common patterns
            const name = row['Name'] || row['Card Name'] || row['Product Name'] || '';
            const number = row['Number'] || row['Card Number'] || row['Collector Number'] || '';
            const rarity = row['Rarity'] || row['Rarity Code'] || '';
            const imageUrl = row['Image URL'] || row['Image'] || row['Front Image'] || '';
            const marketPrice = row['Market Price'] || row['Price'] || '';
            
            if (!name) return null;
            
            // Generate a unique ID
            const id = `${game}_${set.id}_${number || name.replace(/\s+/g, '_')}`.toLowerCase();
            
            return {
                id: id,
                game: game,
                name: name,
                set_name: set.name,
                set_code: set.id,
                card_number: number,
                image_url: imageUrl,
                rarity: rarity,
                card_type: row['Type'] || row['Card Type'] || '',
                card_text: row['Text'] || row['Card Text'] || row['Ability'] || '',
                attributes: {
                    marketPrice: marketPrice,
                    foil: row['Foil'] || false,
                    condition: row['Condition'] || '',
                    language: row['Language'] || 'English',
                    ...this.getGameSpecificAttributes(game, row)
                }
            };
        } catch (error) {
            console.error('Error parsing card from CSV:', error);
            return null;
        }
    }
    
    parseCardFromHTML($, $elem, game, set) {
        try {
            const name = $elem.find('.product-name, .card-name, td:nth-child(2)').text().trim();
            const number = $elem.find('.card-number, td:nth-child(3)').text().trim();
            const rarity = $elem.find('.rarity, td:nth-child(4)').text().trim();
            const price = $elem.find('.price, .market-price, td:nth-child(5)').text().trim();
            
            // Try to find image URL
            let imageUrl = $elem.find('img').attr('src') || '';
            if (!imageUrl) {
                // Look for data attributes
                imageUrl = $elem.attr('data-image') || $elem.attr('data-img-url') || '';
            }
            
            if (!name) return null;
            
            const id = `${game}_${set.id}_${number || name.replace(/\s+/g, '_')}`.toLowerCase();
            
            return {
                id: id,
                game: game,
                name: name,
                set_name: set.name,
                set_code: set.id,
                card_number: number,
                image_url: imageUrl,
                rarity: rarity,
                card_type: '',
                card_text: '',
                attributes: {
                    marketPrice: price
                }
            };
        } catch (error) {
            console.error('Error parsing card from HTML:', error);
            return null;
        }
    }
    
    getGameSpecificAttributes(game, row) {
        const attributes = {};
        
        switch(game) {
            case 'pokemon':
                attributes.hp = row['HP'] || null;
                attributes.stage = row['Stage'] || '';
                attributes.type = row['Type'] || '';
                attributes.weakness = row['Weakness'] || '';
                attributes.resistance = row['Resistance'] || '';
                attributes.retreat = row['Retreat Cost'] || '';
                break;
                
            case 'magic':
                attributes.manaCost = row['Mana Cost'] || '';
                attributes.cmc = row['CMC'] || row['Converted Mana Cost'] || '';
                attributes.power = row['Power'] || null;
                attributes.toughness = row['Toughness'] || null;
                attributes.loyalty = row['Loyalty'] || null;
                break;
                
            case 'yugioh':
                attributes.attack = row['ATK'] || row['Attack'] || null;
                attributes.defense = row['DEF'] || row['Defense'] || null;
                attributes.level = row['Level'] || null;
                attributes.attribute = row['Attribute'] || '';
                break;
                
            case 'lorcana':
                attributes.inkCost = row['Ink Cost'] || null;
                attributes.strength = row['Strength'] || null;
                attributes.willpower = row['Willpower'] || null;
                attributes.lore = row['Lore'] || null;
                break;
                
            case 'onepiece':
                attributes.cost = row['Cost'] || null;
                attributes.power = row['Power'] || null;
                attributes.counter = row['Counter'] || null;
                attributes.color = row['Color'] || '';
                break;
        }
        
        return attributes;
    }
    
    async downloadImage(imageUrl, cardId) {
        if (!imageUrl) return null;
        
        try {
            // Clean up the image URL if it's relative
            if (imageUrl.startsWith('/')) {
                imageUrl = `${this.baseUrl}${imageUrl}`;
            }
            
            const extension = path.extname(new URL(imageUrl).pathname) || '.jpg';
            const imagePath = path.join(this.cacheDir, `${cardId}${extension}`);
            
            // Check if already cached
            if (fs.existsSync(imagePath)) {
                return imagePath;
            }
            
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
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