// server.js - CardCast Main Server
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Import our modules
const Database = require('./src/database');
const TCGApi = require('./src/tcg-api');  // Fixed: Use tcg-api.js instead of tcgcsv-api.js
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

// Load config or create default
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
    // Save default config
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
        .map(key => ({
            id: key,
            name: key.charAt(0).toUpperCase() + key.slice(1),
            enabled: config.games[key].enabled,
            hasData: db.hasGameData(key)
        }));
    res.json(games);
});

app.post('/api/download/:game', async (req, res) => {
    const game = req.params.game;
    
    if (!config.games[game]) {
        return res.status(400).json({ error: 'Invalid game' });
    }
    
    res.json({ message: 'Download started', game });
    
    // Start download in background
    tcgApi.downloadGameData(game, (progress) => {
        io.emit('download-progress', { 
            game, 
            progress: progress.percent || 0,
            message: progress.message || 'Downloading...'
        });
    }).then((cardCount) => {
        io.emit('download-complete', { game, cardCount });
        console.log(`Downloaded ${cardCount} cards for ${game}`);
    }).catch(err => {
        console.error(`Download error for ${game}:`, err);
        
        // Provide specific error messages to users
        let userMessage = err.message;
        if (err.message.includes('Network error') || err.message.includes('ENOTFOUND')) {
            userMessage = `Network error: Cannot connect to ${game} API. Please check your internet connection and try again.`;
        } else if (err.message.includes('Timeout error') || err.message.includes('ETIMEDOUT')) {
            userMessage = `Timeout error: ${game} API is taking too long to respond. Please try again later or check your network speed.`;
        } else if (err.message.includes('Rate limit')) {
            userMessage = `Rate limit error: Too many requests to ${game} API. Please wait a few minutes before trying again.`;
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
    
    // Send current state to new client
    socket.emit('state', overlayServer.getState());
    
    // Handle overlay client registration
    socket.on('register-overlay', (type) => {
        overlayClients.add(socket.id);
        console.log(`Overlay registered: ${type} (${socket.id})`);
        // Notify main clients that OBS is connected
        io.to(Array.from(mainClients)).emit('obs-connected');
    });
    
    // Handle main client registration
    socket.on('register-main', () => {
        mainClients.add(socket.id);
        // Send current OBS status
        if (overlayClients.size > 0) {
            socket.emit('obs-connected');
        } else {
            socket.emit('obs-disconnected');
        }
    });
    
    // Check OBS status request
    socket.on('check-obs-status', () => {
        mainClients.add(socket.id);
        if (overlayClients.size > 0) {
            socket.emit('obs-connected');
        } else {
            socket.emit('obs-disconnected');
        }
    });
    
    socket.on('display-card', (data) => {
        console.log('Display card:', data.card?.name);
        overlayServer.updateCard(data.card);
        
        // Broadcast to all overlay clients
        io.emit('show-card', {
            card: data.card,
            position: data.position || 'left',
            game: data.game
        });
    });
    
    socket.on('clear-display', () => {
        console.log('Clear display');
        overlayServer.clearCard();
        io.emit('clear-card', { position: 'both' });
    });
    
    socket.on('update-prizes', (data) => {
        console.log('Update prizes:', data);
        io.emit('prizes-update', data);
    });
    
    socket.on('decklist-update', (data) => {
        console.log('Update decklist');
        overlayServer.updateDecklist(data.deck?.categories || {});
        io.emit('decklist-update', data);
    });
    
    socket.on('decklist-add-card', (data) => {
        console.log('Add card to decklist:', data.card?.name);
        io.emit('decklist-add-card', data);
    });
    
    socket.on('decklist-clear', () => {
        console.log('Clear decklist');
        overlayServer.updateDecklist([]);
        io.emit('decklist-clear');
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        // Remove from tracking
        const wasOverlay = overlayClients.delete(socket.id);
        mainClients.delete(socket.id);
        
        // If it was an overlay client and no more overlays are connected
        if (wasOverlay && overlayClients.size === 0) {
            // Notify main clients that OBS disconnected
            io.to(Array.from(mainClients)).emit('obs-disconnected');
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