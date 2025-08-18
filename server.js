// server.js - CardCast Main Server
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
}

// Save config
function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Initialize database
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
    const games = Object.keys(config.games).map(key => ({
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
        io.emit('download-progress', { game, progress });
    }).then(() => {
        io.emit('download-complete', { game });
    }).catch(err => {
        io.emit('download-error', { game, error: err.message });
    });
});

app.get('/api/search/:game', (req, res) => {
    const { game } = req.params;
    const { q } = req.query;
    
    if (!q || q.length < 2) {
        return res.json([]);
    }
    
    const results = db.searchCards(game, q);
    res.json(results);
});

app.get('/api/card/:game/:id', (req, res) => {
    const { game, id } = req.params;
    const card = db.getCard(game, id);
    
    if (!card) {
        return res.status(404).json({ error: 'Card not found' });
    }
    
    res.json(card);
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

// Socket.io events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('display-card', (data) => {
        // Broadcast to all overlay clients
        io.emit('show-card', data);
    });
    
    socket.on('clear-display', () => {
        io.emit('clear-card');
    });
    
    socket.on('update-prizes', (data) => {
        io.emit('prizes-update', data);
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
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
    
    // Auto-open browser on Windows
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
    process.exit(0);
});