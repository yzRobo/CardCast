// src/database.js - CardCast Database Handler
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
            { id: 'starwars', name: 'Star Wars Unlimited' },
            { id: 'dragonball', name: 'Dragon Ball Super' },
            { id: 'vanguard', name: 'Cardfight Vanguard' },
            { id: 'weiss', name: 'Weiss Schwarz' },
            { id: 'shadowverse', name: 'Shadowverse Evolve' },
            { id: 'metazoo', name: 'MetaZoo' },
            { id: 'grandarchive', name: 'Grand Archive' },
            { id: 'sorcery', name: 'Sorcery Contested Realm' },
            { id: 'universus', name: 'UniVersus' },
            { id: 'keyforge', name: 'KeyForge' },
            { id: 'force', name: 'Force of Will' }
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
    }
    
    hasGameData(game) {
        const result = this.db.prepare(
            'SELECT card_count FROM games WHERE id = ?'
        ).get(game);
        return result && result.card_count > 0;
    }
    
    searchCards(game, query) {
        const searchTerm = `%${query.toLowerCase()}%`;
        const startTerm = `${query.toLowerCase()}%`;
        return this.searchStmt.all(game, searchTerm, startTerm);
    }
    
    getCard(game, cardId) {
        const card = this.getCardStmt.get(game, cardId);
        if (card) {
            // Update recent cards
            this.updateRecentStmt.run(cardId, game);
            // Parse attributes from JSON
            if (card.attributes) {
                card.attributes = JSON.parse(card.attributes);
            }
        }
        return card;
    }
    
    insertCard(cardData) {
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
    }
    
    bulkInsertCards(cards) {
        const insert = this.db.transaction((cards) => {
            for (const card of cards) {
                this.insertCard(card);
            }
        });
        
        insert(cards);
    }
    
    updateGameInfo(gameId, cardCount) {
        this.db.prepare(`
            UPDATE games 
            SET last_update = ?, card_count = ?
            WHERE id = ?
        `).run(
            Date.now(),
            cardCount,
            gameId
        );
    }
    
    getRecentCards(game, limit = 10) {
        return this.db.prepare(`
            SELECT c.* FROM cards c
            JOIN recent_cards r ON c.id = r.card_id
            WHERE r.game = ?
            ORDER BY r.accessed_at DESC
            LIMIT ?
        `).all(game, limit);
    }
    
    clearGameData(game) {
        this.db.prepare('DELETE FROM cards WHERE game = ?').run(game);
        this.db.prepare('DELETE FROM recent_cards WHERE game = ?').run(game);
        this.db.prepare('UPDATE games SET card_count = 0, last_update = 0 WHERE id = ?').run(game);
    }
    
    getGameStats() {
        return this.db.prepare(`
            SELECT id, name, card_count, last_update 
            FROM games 
            ORDER BY name
        `).all();
    }
    
    close() {
        this.db.close();
    }
}

module.exports = CardDatabase;