// server.js - CardCast Main Server (Updated)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Import our modules
const Database = require('./src/database');
const TCGApi = require('./src/tcg-api');
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
const tcgApi = new TCGApi(db);
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

app.get('/api/search/:game', (req, res) => {
    const { game } = req.params;
    const { q } = req.query;
    
    if (!q || q.length < 2) {
        return res.json([]);
    }
    
    try {
        const results = db.searchCards(game, q);
        res.json(results);
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

// Track overlay connections
let overlayClients = new Set();
let mainClients = new Set();

// Socket.io events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send initial state
    socket.emit('state', overlayServer.getState());
    
    // Handle overlay registration
    socket.on('register-overlay', (type) => {
        overlayClients.add(socket.id);
        console.log(`Overlay registered: ${type} (${socket.id})`);
        
        // Notify all main clients that OBS is connected
        io.emit('obs-status', { connected: true });
    });
    
    // Handle main client registration
    socket.on('register-main', () => {
        mainClients.add(socket.id);
        
        // Send current OBS status to this client
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
    });
    
    // Handle OBS status check
    socket.on('check-obs-status', () => {
        // Send current OBS connection status
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
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
    
    // Prize card events
    socket.on('update-prizes', (data) => {
        console.log('Update prizes:', data);
        overlayServer.updatePrizes(data);
    });
    
    // Decklist events
    socket.on('decklist-update', (data) => {
        console.log('Update decklist');
        overlayServer.updateDecklist(data);
    });
    
    socket.on('decklist-add-card', (data) => {
        console.log('Add card to decklist:', data.card?.name);
        overlayServer.addCardToDeck(data.category, data.card);
    });
    
    socket.on('decklist-clear', () => {
        console.log('Clear decklist');
        overlayServer.clearDecklist();
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        // Check if it was an overlay client
        const wasOverlay = overlayClients.delete(socket.id);
        mainClients.delete(socket.id);
        
        // If it was an overlay and no more overlays are connected, notify main clients
        if (wasOverlay && overlayClients.size === 0) {
            io.emit('obs-status', { connected: false });
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