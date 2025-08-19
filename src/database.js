// src/database.js - CardCast Database Handler with Proper Schema
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class CardDatabase {
    constructor() {
        // Ensure data directory exists
        const dataDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        // Initialize database
        const dbPath = path.join(dataDir, 'cardcast.db');
        this.db = new Database(dbPath);
        
        // Enable WAL mode for better performance
        this.db.pragma('journal_mode = WAL');
        
        // Temporarily disable foreign keys during setup
        this.db.pragma('foreign_keys = OFF');
        
        // Create tables
        this.initializeTables();
        
        // Initialize games
        this.initializeGames();
        
        // Re-enable foreign keys
        this.db.pragma('foreign_keys = ON');
        
        // Prepare statements for performance
        this.prepareStatements();
    }
    
    initializeTables() {
        // Games table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                last_update INTEGER,
                card_count INTEGER DEFAULT 0
            )
        `);
        
        // Main cards table with all common fields and game-specific attributes
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY,
                game TEXT NOT NULL,
                product_id TEXT,
                name TEXT NOT NULL,
                set_name TEXT,
                set_code TEXT,
                card_number TEXT,
                image_url TEXT,
                local_image TEXT,
                rarity TEXT,
                card_type TEXT,
                card_text TEXT,
                search_text TEXT,
                
                -- Pokemon specific fields
                hp INTEGER,
                stage TEXT,
                evolves_from TEXT,
                weakness TEXT,
                resistance TEXT,
                retreat_cost TEXT,
                ability_name TEXT,
                ability_text TEXT,
                attack1_name TEXT,
                attack1_cost TEXT,
                attack1_damage TEXT,
                attack1_text TEXT,
                attack2_name TEXT,
                attack2_cost TEXT,
                attack2_damage TEXT,
                attack2_text TEXT,
                attack3_name TEXT,
                attack3_cost TEXT,
                attack3_damage TEXT,
                attack3_text TEXT,
                
                -- Magic specific fields
                mana_cost TEXT,
                cmc INTEGER,
                power TEXT,
                toughness TEXT,
                loyalty INTEGER,
                colors TEXT,
                color_identity TEXT,
                type_line TEXT,
                oracle_text TEXT,
                flavor_text TEXT,
                
                -- Yu-Gi-Oh specific fields
                attack INTEGER,
                defense INTEGER,
                level INTEGER,
                rank INTEGER,
                link_value INTEGER,
                pendulum_scale INTEGER,
                attribute TEXT,
                monster_type TEXT,
                
                -- Lorcana specific fields
                ink_cost INTEGER,
                strength INTEGER,
                willpower INTEGER,
                lore_value INTEGER,
                inkable BOOLEAN,
                
                -- One Piece specific fields
                cost INTEGER,
                op_power INTEGER,
                counter INTEGER,
                life INTEGER,
                don_value INTEGER,
                trigger_text TEXT,
                
                -- Digimon specific fields
                play_cost INTEGER,
                digivolve_cost INTEGER,
                digivolve_color TEXT,
                dp INTEGER,
                digimon_level INTEGER,
                digimon_type TEXT,
                digimon_attribute TEXT,
                
                -- Flesh and Blood specific fields
                pitch_value INTEGER,
                fab_defense INTEGER,
                fab_attack INTEGER,
                resource_cost INTEGER,
                
                -- Star Wars Unlimited specific fields
                sw_cost INTEGER,
                sw_power INTEGER,
                sw_hp INTEGER,
                aspect TEXT,
                arena TEXT,
                
                -- Metadata
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now')),
                
                FOREIGN KEY (game) REFERENCES games(id)
            )
        `);
        
        // Create indexes for fast searching
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_cards_game ON cards(game);
            CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
            CREATE INDEX IF NOT EXISTS idx_cards_search ON cards(search_text);
            CREATE INDEX IF NOT EXISTS idx_cards_product_id ON cards(game, product_id);
            CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(game, set_code);
            CREATE INDEX IF NOT EXISTS idx_cards_number ON cards(game, card_number);
        `);
        
        // Recent cards table for quick access
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS recent_cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id TEXT NOT NULL,
                game TEXT NOT NULL,
                accessed_at INTEGER DEFAULT (strftime('%s', 'now')),
                FOREIGN KEY (card_id) REFERENCES cards(id)
            )
        `);
        
        // Card cache tracking table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS card_cache (
                card_id TEXT PRIMARY KEY,
                image_path TEXT,
                cached_at INTEGER DEFAULT (strftime('%s', 'now')),
                file_size INTEGER,
                FOREIGN KEY (card_id) REFERENCES cards(id)
            )
        `);
    }
    
    initializeGames() {
        // Initialize all supported games
        const games = [
            { id: 'pokemon', name: 'Pokemon' },
            { id: 'magic', name: 'Magic: The Gathering' },
            { id: 'yugioh', name: 'Yu-Gi-Oh!' },
            { id: 'lorcana', name: 'Disney Lorcana' },
            { id: 'onepiece', name: 'One Piece Card Game' },
            { id: 'digimon', name: 'Digimon Card Game' },
            { id: 'fab', name: 'Flesh and Blood' },
            { id: 'starwars', name: 'Star Wars Unlimited' }
        ];
        
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO games (id, name, last_update, card_count)
            VALUES (?, ?, 0, 0)
        `);
        
        games.forEach(game => {
            stmt.run(game.id, game.name);
        });
    }
    
    prepareStatements() {
        // Check if card exists
        this.checkCardStmt = this.db.prepare(`
            SELECT id, updated_at FROM cards 
            WHERE game = ? AND product_id = ?
        `);
        
        // Search statement
        this.searchStmt = this.db.prepare(`
            SELECT id, name, set_name, card_number, image_url, local_image, rarity, card_type, 
                   hp, mana_cost, attack, defense, cost
            FROM cards 
            WHERE game = ? AND search_text LIKE ?
            ORDER BY 
                CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
                name
            LIMIT 50
        `);
        
        // Insert card statement - now with all fields including local_image
        this.insertCardStmt = this.db.prepare(`
            INSERT OR REPLACE INTO cards 
            (id, game, product_id, name, set_name, set_code, card_number, image_url, local_image,
             rarity, card_type, card_text, search_text,
             hp, stage, evolves_from, weakness, resistance, retreat_cost,
             ability_name, ability_text, attack1_name, attack1_cost, attack1_damage, attack1_text,
             attack2_name, attack2_cost, attack2_damage, attack2_text,
             attack3_name, attack3_cost, attack3_damage, attack3_text,
             mana_cost, cmc, power, toughness, loyalty, colors, color_identity, type_line, oracle_text, flavor_text,
             attack, defense, level, rank, link_value, pendulum_scale, attribute, monster_type,
             ink_cost, strength, willpower, lore_value, inkable,
             cost, op_power, counter, life, don_value, trigger_text,
             play_cost, digivolve_cost, digivolve_color, dp, digimon_level, digimon_type, digimon_attribute,
             pitch_value, fab_defense, fab_attack, resource_cost,
             sw_cost, sw_power, sw_hp, aspect, arena,
             updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?,
                    strftime('%s', 'now'))
        `);
        
        // Get card statement
        this.getCardStmt = this.db.prepare(`
            SELECT * FROM cards WHERE game = ? AND id = ?
        `);
        
        // Update recent cards
        this.updateRecentStmt = this.db.prepare(`
            INSERT INTO recent_cards (card_id, game) VALUES (?, ?)
        `);
        
        // Clear game data statements
        this.clearCardsStmt = this.db.prepare('DELETE FROM cards WHERE game = ?');
        this.clearRecentStmt = this.db.prepare('DELETE FROM recent_cards WHERE game = ?');
        this.resetGameStmt = this.db.prepare('UPDATE games SET card_count = 0, last_update = 0 WHERE id = ?');
        
        // Has game data statement
        this.hasDataStmt = this.db.prepare('SELECT card_count FROM games WHERE id = ?');
        
        // Update game info statement
        this.updateGameStmt = this.db.prepare('UPDATE games SET last_update = ?, card_count = ? WHERE id = ?');
        
        // Count cards for game
        this.countCardsStmt = this.db.prepare('SELECT COUNT(*) as count FROM cards WHERE game = ?');
    }
    
    cardExists(game, productId) {
        try {
            const result = this.checkCardStmt.get(game, productId);
            return result ? result : null;
        } catch (error) {
            console.error(`Error checking if card exists: ${productId}`, error);
            return null;
        }
    }
    
    hasGameData(game) {
        try {
            const result = this.hasDataStmt.get(game);
            return result && result.card_count > 0;
        } catch (error) {
            console.error(`Error checking game data for ${game}:`, error);
            return false;
        }
    }
    
    searchCards(game, query) {
        try {
            const searchTerm = `%${query.toLowerCase()}%`;
            const startTerm = `${query.toLowerCase()}%`;
            return this.searchStmt.all(game, searchTerm, startTerm);
        } catch (error) {
            console.error(`Error searching cards for ${game}:`, error);
            return [];
        }
    }
    
    getCard(game, cardId) {
        try {
            const card = this.getCardStmt.get(game, cardId);
            if (card) {
                // Update recent cards
                this.updateRecentStmt.run(cardId, game);
            }
            return card;
        } catch (error) {
            console.error(`Error getting card ${cardId} for ${game}:`, error);
            return null;
        }
    }
    
    insertCard(cardData) {
        try {
            const searchText = `${cardData.name} ${cardData.set_name} ${cardData.card_number} ${cardData.card_text}`.toLowerCase();
            
            // Check if card already exists
            const existing = this.cardExists(cardData.game, cardData.product_id);
            if (existing && !cardData.forceUpdate) {
                // Skip if card already exists and we're not forcing an update
                return { action: 'skipped', id: existing.id };
            }
            
            // Prepare all the parameters (lots of them!)
            const params = [
                cardData.id,
                cardData.game,
                cardData.product_id,
                cardData.name,
                cardData.set_name,
                cardData.set_code,
                cardData.card_number,
                cardData.image_url,
                cardData.local_image || null,  // Add local_image field
                cardData.rarity,
                cardData.card_type,
                cardData.card_text,
                searchText,
                
                // Pokemon fields
                cardData.hp || null,
                cardData.stage || null,
                cardData.evolves_from || null,
                cardData.weakness || null,
                cardData.resistance || null,
                cardData.retreat_cost || null,
                cardData.ability_name || null,
                cardData.ability_text || null,
                cardData.attack1_name || null,
                cardData.attack1_cost || null,
                cardData.attack1_damage || null,
                cardData.attack1_text || null,
                cardData.attack2_name || null,
                cardData.attack2_cost || null,
                cardData.attack2_damage || null,
                cardData.attack2_text || null,
                cardData.attack3_name || null,
                cardData.attack3_cost || null,
                cardData.attack3_damage || null,
                cardData.attack3_text || null,
                
                // Magic fields
                cardData.mana_cost || null,
                cardData.cmc || null,
                cardData.power || null,
                cardData.toughness || null,
                cardData.loyalty || null,
                cardData.colors || null,
                cardData.color_identity || null,
                cardData.type_line || null,
                cardData.oracle_text || null,
                cardData.flavor_text || null,
                
                // Yu-Gi-Oh fields
                cardData.attack || null,
                cardData.defense || null,
                cardData.level || null,
                cardData.rank || null,
                cardData.link_value || null,
                cardData.pendulum_scale || null,
                cardData.attribute || null,
                cardData.monster_type || null,
                
                // Lorcana fields
                cardData.ink_cost || null,
                cardData.strength || null,
                cardData.willpower || null,
                cardData.lore_value || null,
                cardData.inkable || null,
                
                // One Piece fields
                cardData.cost || null,
                cardData.op_power || null,
                cardData.counter || null,
                cardData.life || null,
                cardData.don_value || null,
                cardData.trigger_text || null,
                
                // Digimon fields
                cardData.play_cost || null,
                cardData.digivolve_cost || null,
                cardData.digivolve_color || null,
                cardData.dp || null,
                cardData.digimon_level || null,
                cardData.digimon_type || null,
                cardData.digimon_attribute || null,
                
                // Flesh and Blood fields
                cardData.pitch_value || null,
                cardData.fab_defense || null,
                cardData.fab_attack || null,
                cardData.resource_cost || null,
                
                // Star Wars Unlimited fields
                cardData.sw_cost || null,
                cardData.sw_power || null,
                cardData.sw_hp || null,
                cardData.aspect || null,
                cardData.arena || null
            ];
            
            this.insertCardStmt.run(...params);
            
            return { action: existing ? 'updated' : 'inserted', id: cardData.id };
        } catch (error) {
            console.error(`Error inserting card ${cardData.id}:`, error);
            throw error;
        }
    }
    
    bulkInsertCards(cards, skipExisting = true) {
        const results = {
            inserted: 0,
            updated: 0,
            skipped: 0,
            failed: 0
        };
        
        const insert = this.db.transaction((cards) => {
            for (const card of cards) {
                try {
                    // Set whether to force update or skip existing
                    card.forceUpdate = !skipExisting;
                    const result = this.insertCard(card);
                    
                    if (result.action === 'inserted') results.inserted++;
                    else if (result.action === 'updated') results.updated++;
                    else if (result.action === 'skipped') results.skipped++;
                    
                } catch (error) {
                    console.error(`Error inserting card ${card.id}:`, error);
                    results.failed++;
                }
            }
        });
        
        try {
            insert(cards);
            console.log(`Bulk insert results: ${results.inserted} inserted, ${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed`);
        } catch (error) {
            console.error('Error in bulk insert:', error);
            // Try inserting one by one as fallback
            cards.forEach(card => {
                try {
                    card.forceUpdate = !skipExisting;
                    this.insertCard(card);
                } catch (err) {
                    console.error(`Failed to insert card ${card.id}:`, err);
                }
            });
        }
        
        return results;
    }
    
    updateGameInfo(gameId, cardCount) {
        try {
            // If cardCount is not provided, count the cards
            if (cardCount === undefined || cardCount === null) {
                const result = this.countCardsStmt.get(gameId);
                cardCount = result ? result.count : 0;
            }
            
            this.updateGameStmt.run(Date.now(), cardCount, gameId);
        } catch (error) {
            console.error(`Error updating game info for ${gameId}:`, error);
        }
    }
    
    getRecentCards(game, limit = 10) {
        try {
            return this.db.prepare(`
                SELECT c.* FROM cards c
                JOIN recent_cards r ON c.id = r.card_id
                WHERE r.game = ?
                ORDER BY r.accessed_at DESC
                LIMIT ?
            `).all(game, limit);
        } catch (error) {
            console.error(`Error getting recent cards for ${game}:`, error);
            return [];
        }
    }
    
    clearGameData(game) {
        console.log(`Clearing game data for ${game}...`);
        
        const clearTransaction = this.db.transaction(() => {
            try {
                // Delete in correct order due to foreign key constraints
                const recentResult = this.clearRecentStmt.run(game);
                console.log(`Deleted ${recentResult.changes} recent cards for ${game}`);
                
                const cardsResult = this.clearCardsStmt.run(game);
                console.log(`Deleted ${cardsResult.changes} cards for ${game}`);
                
                const resetResult = this.resetGameStmt.run(game);
                console.log(`Reset game info for ${game}`);
                
                return true;
            } catch (error) {
                console.error(`Error in clearGameData transaction for ${game}:`, error);
                throw error;
            }
        });
        
        try {
            clearTransaction();
            console.log(`Successfully cleared all data for ${game}`);
        } catch (error) {
            console.error(`Failed to clear game data for ${game}:`, error);
            
            // If foreign key constraint fails, try alternative approach
            if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                console.log('Attempting alternative clear method with foreign keys disabled...');
                try {
                    this.db.pragma('foreign_keys = OFF');
                    this.clearRecentStmt.run(game);
                    this.clearCardsStmt.run(game);
                    this.resetGameStmt.run(game);
                    this.db.pragma('foreign_keys = ON');
                    console.log('Successfully cleared data with alternative method');
                } catch (altError) {
                    this.db.pragma('foreign_keys = ON');
                    throw altError;
                }
            } else {
                throw new Error(`Database error: Failed to clear data for ${game}`);
            }
        }
    }
    
    getGameStats() {
        try {
            return this.db.prepare(`
                SELECT id, name, card_count, last_update 
                FROM games 
                ORDER BY name
            `).all();
        } catch (error) {
            console.error('Error getting game stats:', error);
            return [];
        }
    }
    
    // Save image cache info
    saveImageCache(cardId, imagePath, fileSize) {
        try {
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO card_cache (card_id, image_path, file_size, cached_at)
                VALUES (?, ?, ?, strftime('%s', 'now'))
            `);
            stmt.run(cardId, imagePath, fileSize);
        } catch (error) {
            console.error('Error saving image cache info:', error);
        }
    }
    
    // Get cached image info
    getCachedImage(cardId) {
        try {
            const stmt = this.db.prepare(`
                SELECT image_path, cached_at FROM card_cache WHERE card_id = ?
            `);
            return stmt.get(cardId);
        } catch (error) {
            console.error('Error getting cached image:', error);
            return null;
        }
    }
    
    close() {
        try {
            this.db.close();
        } catch (error) {
            console.error('Error closing database:', error);
        }
    }
}

module.exports = CardDatabase;