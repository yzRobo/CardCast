// src/database.js - CardCast Database Handler (Fixed)
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
        
        // Cards table - stores all cards from all games
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cards (
                id TEXT PRIMARY KEY,
                game TEXT NOT NULL,
                name TEXT NOT NULL,
                set_name TEXT,
                set_code TEXT,
                card_number TEXT,
                image_url TEXT,
                rarity TEXT,
                card_type TEXT,
                card_text TEXT,
                attributes TEXT,
                search_text TEXT,
                FOREIGN KEY (game) REFERENCES games(id)
            )
        `);
        
        // Create indexes for fast searching
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_cards_game ON cards(game);
            CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
            CREATE INDEX IF NOT EXISTS idx_cards_search ON cards(search_text);
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
        // Search statement
        this.searchStmt = this.db.prepare(`
            SELECT id, name, set_name, card_number, image_url, rarity, card_type
            FROM cards 
            WHERE game = ? AND search_text LIKE ?
            ORDER BY 
                CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
                name
            LIMIT 50
        `);
        
        // Insert card statement
        this.insertCardStmt = this.db.prepare(`
            INSERT OR REPLACE INTO cards 
            (id, game, name, set_name, set_code, card_number, image_url, 
             rarity, card_type, card_text, attributes, search_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                // Parse attributes from JSON
                if (card.attributes) {
                    try {
                        card.attributes = JSON.parse(card.attributes);
                    } catch (e) {
                        card.attributes = {};
                    }
                }
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
            const attributes = JSON.stringify(cardData.attributes || {});
            
            this.insertCardStmt.run(
                cardData.id,
                cardData.game,
                cardData.name,
                cardData.set_name,
                cardData.set_code,
                cardData.card_number,
                cardData.image_url,
                cardData.rarity,
                cardData.card_type,
                cardData.card_text,
                attributes,
                searchText
            );
        } catch (error) {
            console.error(`Error inserting card ${cardData.id}:`, error);
            throw error;
        }
    }
    
    bulkInsertCards(cards) {
        const insert = this.db.transaction((cards) => {
            for (const card of cards) {
                try {
                    this.insertCard(card);
                } catch (error) {
                    console.error(`Error inserting card ${card.id}:`, error);
                    // Continue with other cards
                }
            }
        });
        
        try {
            insert(cards);
        } catch (error) {
            console.error('Error in bulk insert:', error);
            // Try inserting one by one as fallback
            cards.forEach(card => {
                try {
                    this.insertCard(card);
                } catch (err) {
                    console.error(`Failed to insert card ${card.id}:`, err);
                }
            });
        }
    }
    
    updateGameInfo(gameId, cardCount) {
        try {
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
                // IMPORTANT: Delete in correct order due to foreign key constraints
                // 1. First delete recent cards (they reference cards table)
                const recentResult = this.clearRecentStmt.run(game);
                console.log(`Deleted ${recentResult.changes} recent cards for ${game}`);
                
                // 2. Then delete cards (no longer referenced by recent_cards)
                const cardsResult = this.clearCardsStmt.run(game);
                console.log(`Deleted ${cardsResult.changes} cards for ${game}`);
                
                // 3. Finally reset game info
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
                    // Temporarily disable foreign keys
                    this.db.pragma('foreign_keys = OFF');
                    
                    // Delete everything
                    this.clearRecentStmt.run(game);
                    this.clearCardsStmt.run(game);
                    this.resetGameStmt.run(game);
                    
                    // Re-enable foreign keys
                    this.db.pragma('foreign_keys = ON');
                    
                    console.log('Successfully cleared data with alternative method');
                } catch (altError) {
                    // Re-enable foreign keys even on error
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
    
    close() {
        try {
            this.db.close();
        } catch (error) {
            console.error('Error closing database:', error);
        }
    }
}

module.exports = CardDatabase;