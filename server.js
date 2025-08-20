// server.js - CardCast Main Server (Updated with Set Mappings)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Import our modules
const Database = require('./src/database');
const TCGCSVApi = require('./src/tcg-api');
const OverlayServer = require('./src/overlay-server');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Load config
const configPath = path.join(__dirname, 'config.json');
let config = {
    port: 3888,
    theme: 'dark',
    autoUpdate: true,
    games: {
        pokemon: { enabled: true, dataPath: null },
        magic: { enabled: true, dataPath: null },
        yugioh: { enabled: true, dataPath: null },
        lorcana: { enabled: true, dataPath: null },
        onepiece: { enabled: true, dataPath: null },
        digimon: { enabled: false, dataPath: null },
        fab: { enabled: false, dataPath: null },
        starwars: { enabled: false, dataPath: null }
    },
    obs: {
        mainOverlayPort: 3888,
        prizeOverlayPort: 3889,
        decklistPort: 3890
    }
};

// Load existing config if it exists
if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.log('Error loading config, using defaults');
    }
} else {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Save config function
function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Initialize components
const db = new Database();
const tcgApi = new TCGCSVApi(db);
const overlayServer = new OverlayServer(io);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve cached images
app.use('/cache', express.static(path.join(__dirname, 'cache')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Routes
app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    saveConfig();
    res.json({ success: true, config });
});

app.get('/api/games', (req, res) => {
    const games = Object.keys(config.games)
        .filter(key => config.games[key].enabled)
        .map(key => {
            const hasData = db.hasGameData(key);
            const stats = db.getGameStats().find(g => g.id === key);
            return {
                id: key,
                name: key.charAt(0).toUpperCase() + key.slice(1),
                enabled: config.games[key].enabled,
                hasData: hasData,
                cardCount: stats?.card_count || 0,
                lastUpdate: stats?.last_update || null
            };
        });
    res.json(games);
});

// Pokemon set mappings endpoint - NEW!
app.get('/api/pokemon/set-mappings', (req, res) => {
    try {
        const mappings = db.getSetMappings('pokemon');
        
        // Convert to a map format for easy lookup
        const mappingObject = {};
        mappings.forEach(row => {
            if (row.set_abbreviation) {
                mappingObject[row.set_abbreviation.toUpperCase()] = row.set_name;
            }
        });
        
        res.json(mappingObject);
    } catch (error) {
        console.error('Error fetching set mappings:', error);
        res.status(500).json({ error: 'Failed to fetch set mappings' });
    }
});

// Pokemon sets endpoint - NEW!
app.get('/api/pokemon/sets', (req, res) => {
    try {
        const query = `
            SELECT DISTINCT 
                set_name,
                set_code,
                set_abbreviation,
                COUNT(*) as card_count
            FROM cards 
            WHERE game = 'pokemon' 
                AND set_name IS NOT NULL
            GROUP BY set_name, set_code, set_abbreviation
            ORDER BY set_name
        `;
        
        const sets = db.db.prepare(query).all();
        res.json(sets);
        
    } catch (error) {
        console.error('Error fetching Pokemon sets:', error);
        res.status(500).json({ error: 'Failed to fetch Pokemon sets' });
    }
});

// Delete game data endpoint
app.delete('/api/games/:game/data', (req, res) => {
    const game = req.params.game;
    
    console.log(`DELETE request for game: ${game}`);
    
    if (!config.games[game]) {
        console.error(`Invalid game requested for deletion: ${game}`);
        return res.status(400).json({ error: 'Invalid game' });
    }
    
    let dbCleared = false;
    let imagesCleared = false;
    let errors = [];
    
    try {
        // Clear database
        console.log(`Attempting to clear database for ${game}...`);
        try {
            db.clearGameData(game);
            dbCleared = true;
            console.log(`Database cleared successfully for ${game}`);
        } catch (dbError) {
            console.error(`Database clear error for ${game}:`, dbError);
            errors.push(`Database: ${dbError.message}`);
        }
        
        // Clear cached images
        const imagesDir = path.join(__dirname, 'cache', 'images', game);
        console.log(`Checking for images directory: ${imagesDir}`);
        
        if (fs.existsSync(imagesDir)) {
            try {
                const files = fs.readdirSync(imagesDir);
                console.log(`Found ${files.length} image files to delete`);
                
                let deletedCount = 0;
                let failedFiles = [];
                
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(imagesDir, file));
                        deletedCount++;
                    } catch (fileErr) {
                        console.error(`Could not delete ${file}:`, fileErr.message);
                        failedFiles.push(file);
                    }
                });
                
                console.log(`Deleted ${deletedCount}/${files.length} cached images for ${game}`);
                if (failedFiles.length > 0) {
                    errors.push(`Failed to delete ${failedFiles.length} image files`);
                }
                imagesCleared = deletedCount > 0 || files.length === 0;
            } catch (dirErr) {
                console.error(`Error reading images directory for ${game}:`, dirErr);
                errors.push(`Images directory: ${dirErr.message}`);
            }
        } else {
            console.log(`No images directory found for ${game}`);
            imagesCleared = true; // No directory means no images to clear
        }
        
        // If at least database was cleared, consider it a success
        if (dbCleared) {
            const message = errors.length > 0 
                ? `Deleted data for ${game} with some warnings: ${errors.join(', ')}`
                : `Successfully deleted all data for ${game}`;
                
            console.log(message);
            
            res.json({ 
                success: true, 
                message: message,
                warnings: errors
            });
            
            // Notify connected clients
            io.emit('data-deleted', { game });
        } else {
            throw new Error('Failed to clear database');
        }
        
    } catch (error) {
        console.error(`Critical error deleting data for ${game}:`, error);
        console.error('Stack trace:', error.stack);
        
        res.status(500).json({ 
            error: 'Failed to delete data', 
            details: error.message,
            errors: errors
        });
    }
});

app.post('/api/download/:game', async (req, res) => {
    const game = req.params.game;
    const incremental = req.body.incremental || false;
    const setCount = req.body.setCount || 'all'; // How many sets to download
    
    if (!config.games[game]) {
        return res.status(400).json({ error: 'Invalid game' });
    }
    
    res.json({ 
        message: incremental ? 'Update started' : 'Download started', 
        game,
        mode: incremental ? 'incremental' : 'full',
        setCount
    });
    
    // Start download in background
    tcgApi.downloadGameData(game, (progress) => {
        io.emit('download-progress', { 
            game, 
            progress: progress.percent || 0,
            message: progress.message || 'Processing...'
        });
    }, incremental, setCount).then((cardCount) => {
        io.emit('download-complete', { 
            game, 
            cardCount,
            incremental 
        });
        console.log(`${incremental ? 'Updated' : 'Downloaded'} ${cardCount} cards for ${game}`);
    }).catch(err => {
        console.error(`${incremental ? 'Update' : 'Download'} error for ${game}:`, err);
        
        let userMessage = err.message;
        if (err.message.includes('Network error') || err.message.includes('ENOTFOUND')) {
            userMessage = `Network error: Cannot connect to ${game} API. Please check your internet connection and try again.`;
        } else if (err.message.includes('Timeout error') || err.message.includes('ETIMEDOUT') || err.message.includes('timeout')) {
            userMessage = `Timeout error: ${game} API is taking too long to respond. Please try again later or check your network speed.`;
        } else if (err.message.includes('Rate limit')) {
            userMessage = `Rate limit error: Too many requests to ${game} API. Please wait a few minutes before trying again.`;
        } else if (err.message.includes('No cards were fetched')) {
            userMessage = `Failed to fetch cards for ${game}. The API might be down or the format may have changed.`;
        }
        
        io.emit('download-error', { 
            game, 
            error: userMessage,
            details: err.message,
            canRetry: !err.message.includes('Rate limit')
        });
    });
});

// Enhanced search endpoint that handles set abbreviations - UPDATED!
app.get('/api/search/:game', (req, res) => {
    const { game } = req.params;
    const { q } = req.query;
    
    if (!q || q.length < 2) {
        return res.json([]);
    }
    
    try {
        // Use the database's searchCards method which now handles set abbreviations
        const results = db.searchCards(game, q);
        
        // Use local_image if available, otherwise fall back to image_url
        const processedResults = results.map(card => ({
            ...card,
            display_image: card.local_image || card.image_url
        }));
        
        res.json(processedResults);
    } catch (error) {
        console.error('Search error:', error);
        res.json([]);
    }
});

app.get('/api/card/:game/:id', (req, res) => {
    const { game, id } = req.params;
    
    try {
        const card = db.getCard(game, id);
        
        if (!card) {
            return res.status(404).json({ error: 'Card not found' });
        }
        
        // Add display_image field that uses local if available
        card.display_image = card.local_image || card.image_url;
        
        res.json(card);
    } catch (error) {
        console.error('Get card error:', error);
        res.status(500).json({ error: 'Failed to get card' });
    }
});

// Get game statistics
app.get('/api/stats/:game', (req, res) => {
    const { game } = req.params;
    
    try {
        const stats = db.getGameStats().find(g => g.id === game);
        const cacheDir = path.join(__dirname, 'cache', 'images', game);
        let imageCount = 0;
        let cacheSize = 0;
        
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            imageCount = files.length;
            
            files.forEach(file => {
                const filePath = path.join(cacheDir, file);
                const stat = fs.statSync(filePath);
                cacheSize += stat.size;
            });
        }
        
        res.json({
            game: game,
            cardCount: stats?.card_count || 0,
            lastUpdate: stats?.last_update || null,
            imageCount: imageCount,
            cacheSize: (cacheSize / 1024 / 1024).toFixed(2) + ' MB'
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Overlay endpoints
app.get('/overlay', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'main.html'));
});

app.get('/prizes', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'prizes.html'));
});

app.get('/decklist', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'decklist.html'));
});

app.get('/pokemon-match', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'pokemon-match.html'));
});

app.get('/pokemon-match-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'pokemon-match-control.html'));
});

// Track overlay connections
let overlayClients = new Set();
let mainClients = new Set();
let controlClients = new Set();
let overlayStates = {
    'pokemon-match': false,
    'prizes': false,
    'decklist': false,
    'main': false
};

// Socket.io events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send initial state
    socket.emit('state', overlayServer.getState());
    
    // Handle overlay registration
    socket.on('register-overlay', (type) => {
        overlayClients.add(socket.id);
        overlayStates[type] = true;
        console.log(`Overlay registered: ${type} (${socket.id})`);
        
        // Notify all control panels that overlay is connected
        io.emit('overlay-connected', type);
        
        // Notify all main clients that OBS is connected
        io.emit('obs-status', { connected: true });
        
        // Send current state to the overlay
        const state = overlayServer.getState();
        if (type === 'pokemon-match') {
            socket.emit('pokemon-match-state', state.pokemonMatch);
            // Also send as update for compatibility
            socket.emit('pokemon-match-update', {
                player1: state.pokemonMatch.player1,
                player2: state.pokemonMatch.player2,
                stadium: state.pokemonMatch.stadium
            });
        } else if (type === 'prizes') {
            socket.emit('prizes-state', state);
        } else if (type === 'decklist') {
            socket.emit('decklist-state', state);
        }
    });
    
    // Handle control panel registration
    socket.on('register-control', (type) => {
        controlClients.add(socket.id);
        console.log(`Control panel registered: ${type} (${socket.id})`);
        
        // Send current overlay connection states
        Object.keys(overlayStates).forEach(overlayType => {
            if (overlayStates[overlayType]) {
                socket.emit('overlay-connected', overlayType);
            }
        });
    });
    
    // Handle main client registration
    socket.on('register-main', () => {
        mainClients.add(socket.id);
        
        // Send current OBS status to this client
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
    });
    
    // Request state (from overlays)
    socket.on('request-state', (type) => {
        console.log(`State requested for ${type}`);
        const state = overlayServer.getState();
        
        if (type === 'prizes') {
            socket.emit('prizes-update', {
                player1: state.prizeCards.player1,
                player2: state.prizeCards.player2,
                game: 'pokemon',
                show: true
            });
        } else if (type === 'decklist') {
            socket.emit('decklist-update', {
                deck: state.decklist,
                show: true
            });
        } else if (type === 'pokemon-match') {
            // Send the pokemonMatch state from the overlay server
            socket.emit('pokemon-match-state', state.pokemonMatch);
            // Also send as update for compatibility
            socket.emit('pokemon-match-update', {
                player1: state.pokemonMatch.player1,
                player2: state.pokemonMatch.player2,
                stadium: state.pokemonMatch.stadium
            });
        }
    });
    
    // Handle OBS status check
    socket.on('check-obs-status', () => {
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
    });
    
    // Check overlay status
    socket.on('check-overlay-status', (type) => {
        if (overlayStates[type]) {
            socket.emit('overlay-connected', type);
        } else {
            socket.emit('overlay-disconnected', type);
        }
    });
    
    // Display card event
    socket.on('display-card', (data) => {
        console.log('Display card:', data.card?.name);
        overlayServer.updateCard(data.card, data.position);
        
        // Emit to all overlay clients
        io.emit('show-card', {
            card: data.card,
            position: data.position || 'left',
            game: data.game
        });
    });
    
    // Clear display event
    socket.on('clear-display', () => {
        console.log('Clear display');
        overlayServer.clearCard();
        io.emit('clear-card', { position: 'both' });
    });
    
    // Pokemon Match events
    socket.on('pokemon-match-update', (data) => {
        console.log('Pokemon match update:', data);
        overlayServer.updatePokemonMatch(data);  // Store in overlay server
        io.emit('pokemon-match-update', data);
    });
    
    socket.on('active-pokemon', (data) => {
        console.log('Active pokemon update for player', data.player);
        overlayServer.updateActivePokemon(data.player, data.pokemon);  // Store in overlay server
        io.emit('active-pokemon', data);
    });
    
    socket.on('bench-update', (data) => {
        console.log('Bench update for player', data.player);
        overlayServer.updateBench(data.player, data.bench);  // Store in overlay server
        io.emit('bench-update', data);
    });
    
    socket.on('prize-taken', (data) => {
        console.log('Prize taken:', data);
        overlayServer.takePrize(data.player, data.index);
        io.emit('prize-taken', data);
    });
    
    socket.on('prizes-reset', () => {
        console.log('Prizes reset');
        overlayServer.resetPrizes();
        io.emit('prizes-reset');
    });
    
    socket.on('turn-switch', (data) => {
        console.log('Turn switch:', data);
        io.emit('turn-switch', data);
    });
    
    socket.on('timer-start', () => {
        console.log('Timer start');
        io.emit('timer-start');
    });
    
    socket.on('timer-pause', () => {
        console.log('Timer pause');
        io.emit('timer-pause');
    });
    
    socket.on('timer-reset', () => {
        console.log('Timer reset');
        io.emit('timer-reset');
    });
    
    socket.on('match-reset', () => {
        console.log('Match reset');
        io.emit('match-reset');
    });
    
    socket.on('match-settings', (data) => {
        console.log('Match settings:', data);
        io.emit('match-settings', data);
    });
    
    socket.on('toggle-pokemon-match', (data) => {
        console.log('Toggle pokemon match overlay:', data.show);
        io.emit('toggle-pokemon-match', data);
    });
    
    socket.on('toggle-prizes', (data) => {
        console.log('Toggle prizes overlay:', data.show);
        io.emit('toggle-prizes', data);
    });
    
    // Stadium events
    socket.on('stadium-update', (data) => {
        console.log('Stadium update:', data.stadium);
        overlayServer.updateStadium(data.stadium);
        io.emit('stadium-update', data);
    });
    
    // Player record events
    socket.on('record-update', (data) => {
        console.log('Record update for player', data.player, ':', data.record);
        overlayServer.updatePlayerRecord(data.player, data.record);
        io.emit('record-update', data);
    });
    
    // Match score events
    socket.on('match-score-update', (data) => {
        console.log('Match score update for player', data.player, ':', data.score);
        overlayServer.updateMatchScore(data.player, data.score);
        io.emit('match-score-update', data);
    });
    
    // Turn actions events
    socket.on('turn-actions-update', (data) => {
        console.log('Turn actions update for player', data.player, ':', data.actions);
        overlayServer.updateTurnActions(data.player, data.actions);
        io.emit('turn-actions-update', data);
    });
    
    socket.on('turn-actions-reset', () => {
        console.log('Turn actions reset');
        overlayServer.resetTurnActions();
        io.emit('turn-actions-reset');
    });
    
    // Bench size events
    socket.on('bench-size-update', (data) => {
        console.log('Bench size update for player', data.player, ':', data.size);
        overlayServer.updateBenchSize(data.player, data.size);
        io.emit('bench-size-update', data);
    });
    
    // Prize card events (alternative handling)
    socket.on('update-prizes', (data) => {
        console.log('Update prizes:', data);
        overlayServer.updatePrizes(data);
        io.emit('prizes-update', data);
    });
    
    // Decklist events
    socket.on('decklist-update', (data) => {
        console.log('Update decklist');
        overlayServer.updateDecklist(data);
        io.emit('decklist-update', data);
    });
    
    socket.on('decklist-add-card', (data) => {
        console.log('Add card to decklist:', data.card?.name);
        overlayServer.addCardToDeck(data.category, data.card);
    });
    
    socket.on('decklist-clear', () => {
        console.log('Clear decklist');
        overlayServer.clearDecklist();
        io.emit('decklist-clear');
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        // Check if it was an overlay client
        const wasOverlay = overlayClients.delete(socket.id);
        const wasControl = controlClients.delete(socket.id);
        mainClients.delete(socket.id);
        
        if (wasOverlay) {
            // Check which overlay disconnected
            Object.keys(overlayStates).forEach(type => {
                // For simplicity, mark all as disconnected when any overlay disconnects
                // In production, you'd track which specific overlay each socket represents
                overlayStates[type] = false;
            });
            
            // Notify control panels
            io.emit('overlay-disconnected', 'pokemon-match');
            
            // If no more overlays are connected, notify main clients
            if (overlayClients.size === 0) {
                io.emit('obs-status', { connected: false });
            }
        }
    });
});

// Start server
const PORT = config.port || 3888;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║          CardCast v1.0.0              ║
║     TCG Streaming Overlay Tool        ║
╚═══════════════════════════════════════╝

Server running on http://localhost:${PORT}
OBS Overlays:
  - Main: http://localhost:${PORT}/overlay
  - Prizes: http://localhost:${PORT}/prizes  
  - Decklist: http://localhost:${PORT}/decklist
  - Pokemon Match: http://localhost:${PORT}/pokemon-match

Cache directory: ${path.join(__dirname, 'cache')}
Database: ${path.join(__dirname, 'data', 'cardcast.db')}

Opening browser...
`);
    
    // Auto-open browser
    const url = `http://localhost:${PORT}`;
    switch (process.platform) {
        case 'win32':
            exec(`start ${url}`);
            break;
        case 'darwin':
            exec(`open ${url}`);
            break;
        case 'linux':
            exec(`xdg-open ${url}`);
            break;
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down CardCast...');
    db.close();
    server.close();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});